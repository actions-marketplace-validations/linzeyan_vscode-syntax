import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { nextChangedFile } from "./changes";
import { imageReferences } from "./images";
import { indentSpans } from "./indent";
import {
  Dialect,
  enterAction,
  indentTarget,
  listItem,
  outdentTarget,
  renumberedAfterMove,
  renumberedTail,
  Rewrite,
} from "./list";
import { toc, TOC_END, TOC_START } from "./markdown";
import { describe, EXPR_MARK, POSTFIX_LANGUAGES, postfixesFor, postfixTarget } from "./postfix";
import { REFACTOR_KIND, refactorChoices, Refactoring } from "./refactors";
import { countElsewhere, implLabel, lensTargets, refLabel } from "./references";
import { registerTodoTree } from "./todoTree";

/**
 * A `path:line` reference, in the shape poly's diagnostics already print.
 *
 * VSCode's own Copy Relative Path stops at the path; the line is the whole
 * delta. It matters because the result is not prose -- `src/lib.rs:42` is what
 * rg prints, what a CI annotation links to, and what a terminal turns into a
 * clickable jump. A reference that agrees with those is one the reader can act
 * on without translating it first.
 *
 * A multi-line selection becomes `path:42-51`; anything else is the cursor's
 * own line. Forward slashes on every platform, because the consumers above are
 * the same tools on Windows.
 */
function reference(editor: vscode.TextEditor): string {
  const uri = editor.document.uri;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const relative = folder
    ? path.relative(folder.uri.fsPath, uri.fsPath)
    : uri.fsPath;
  const file = relative.split(path.sep).join("/");

  const selection = editor.selection;
  const start = selection.start.line + 1;
  // A selection that ends at column 0 stopped at the line break rather than
  // reaching into that line, so the line the user dragged past is not part of
  // what they selected.
  const last = selection.end.character === 0 && selection.end.line > selection.start.line
    ? selection.end.line
    : selection.end.line + 1;
  return start === last ? `${file}:${start}` : `${file}:${start}-${last}`;
}

/** Is `text` its own pair of markers, rather than one empty pair? */
function wrapped(text: string, marker: string): boolean {
  return text.length > marker.length * 2
    && text.startsWith(marker)
    && text.endsWith(marker);
}

/**
 * The range including the markers that already surround `range`, if they do.
 *
 * Toggling off has to work on the selection someone actually makes, and after
 * a previous toggle that is usually the text *between* the markers rather than
 * the markers with it.
 */
function surrounding(
  document: vscode.TextDocument,
  range: vscode.Range,
  marker: string,
): vscode.Range | undefined {
  const start = document.offsetAt(range.start) - marker.length;
  if (start < 0) {
    return undefined;
  }
  const end = document.offsetAt(range.end) + marker.length;
  const outer = new vscode.Range(document.positionAt(start), document.positionAt(end));
  const text = document.getText(outer);
  // positionAt clamps at the end of the document, so a short result means the
  // closing marker would have run past it and is not there.
  const complete = text.length === document.getText(range).length + marker.length * 2;
  return complete && text.startsWith(marker) && text.endsWith(marker)
    ? outer
    : undefined;
}

/** One replacement, and how far it moves a cursor that was inside it. */
interface Emphasis {
  start: number;
  end: number;
  text: string;
  /** Markers added before the caret shift it right; removed ones, left. */
  inner: number;
}

/** What toggling `marker` does to `range`, as offsets into the document. */
function emphasisEdit(
  document: vscode.TextDocument,
  range: vscode.Range,
  marker: string,
): Emphasis {
  const text = document.getText(range);
  const start = document.offsetAt(range.start);
  if (wrapped(text, marker)) {
    return {
      start,
      end: document.offsetAt(range.end),
      text: text.slice(marker.length, text.length - marker.length),
      inner: -marker.length,
    };
  }
  const outer = surrounding(document, range, marker);
  if (outer) {
    return {
      start: document.offsetAt(outer.start),
      end: document.offsetAt(outer.end),
      text,
      inner: -marker.length,
    };
  }
  return {
    start,
    end: document.offsetAt(range.end),
    text: `${marker}${text}${marker}`,
    inner: marker.length,
  };
}

/**
 * Where `offset` ends up once every edit has been applied.
 *
 * A caret inside the text being wrapped has to travel with the character it was
 * on, or bolding a word leaves the caret two columns from where its owner put
 * it and the next keystroke lands in the wrong place. Boundaries deliberately
 * do not travel: a selection of the whole word still contains the whole word,
 * markers and all.
 */
function movedBy(offset: number, edits: Emphasis[]): number {
  let shift = 0;
  for (const edit of edits) {
    // An edit with nothing between its ends is a pair of markers opened where
    // the caret was -- Ctrl+B on an empty line. Both rules below claim that
    // offset, and "after the edit" is the wrong winner: it leaves the caret
    // past the closing marker, so the word it was about to bold is not bolded.
    if (edit.start === edit.end && offset === edit.start) {
      return offset + edit.inner + shift;
    }
    if (offset >= edit.end) {
      shift += edit.text.length - (edit.end - edit.start);
    } else if (offset > edit.start) {
      const inside = Math.min(
        Math.max(offset + edit.inner, edit.start),
        edit.start + edit.text.length,
      );
      return inside + shift;
    }
  }
  return offset + shift;
}

/**
 * Wrap or unwrap every selection with `marker`.
 *
 * `**` for strong and `_` for emphasis, which is what `poly fmt` normalizes
 * markdown to -- a toggle that produced the other spelling would be undone by
 * the next save, and the two commands would be quietly fighting each other.
 */
async function toggleEmphasis(
  editor: vscode.TextEditor,
  marker: string,
): Promise<void> {
  const document = editor.document;
  const targets = editor.selections.map((selection) =>
    selection.isEmpty
      // An empty selection means the word the cursor is in, which is what
      // anyone who hits the shortcut mid-word meant by it.
      ? document.getWordRangeAtPosition(selection.active)
        ?? new vscode.Range(selection.active, selection.active)
      : new vscode.Range(selection.start, selection.end)
  );
  const edits = targets
    .map((range) => emphasisEdit(document, range, marker))
    .sort((a, b) => a.start - b.start);
  // Captured as offsets before the edit, because the Position objects are about
  // to describe a document that no longer exists.
  const carets = editor.selections.map((selection) => ({
    anchor: document.offsetAt(selection.anchor),
    active: document.offsetAt(selection.active),
  }));

  await editor.edit((builder) => {
    for (const edit of edits) {
      builder.replace(
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
        edit.text,
      );
    }
  });

  editor.selections = carets.map(({ anchor, active }) =>
    new vscode.Selection(
      document.positionAt(movedBy(anchor, edits)),
      document.positionAt(movedBy(active, edits)),
    )
  );
}

/**
 * The language ids that are markdown, whatever VSCode calls them.
 *
 * `prompt-basics` takes `SKILL.md`, `*.prompt.md`, `*.instructions.md`,
 * `.claude/rules/**`, `.claude/agents/**` and friends away from the `markdown`
 * id, and it contributes no list behaviour of its own. Anything keyed on
 * `markdown` alone silently stops working in exactly the files that are most
 * often edited as markdown. The same list is spelled out in the `when` clauses
 * in package.json, which cannot read this one.
 */
const MARKDOWN_LANGUAGES = new Set([
  "markdown",
  "prompt",
  "instructions",
  "chatagent",
  "skill",
]);

/**
 * The list dialect each language id speaks.
 *
 * The markdown family shares one. yaml is its own: `>` opens a folded block
 * scalar there and `1.` is just a string, so continuing either the way
 * markdown does would corrupt the file.
 */
const DIALECTS = new Map<string, Dialect>([
  ...[...MARKDOWN_LANGUAGES].map((id): [string, Dialect] => [id, "markdown"]),
  ["yaml", "yaml"],
]);

/**
 * Enter inside a list item.
 *
 * Bound to Enter, so -- like the Tab commands -- every path it does not handle
 * forwards to what the key already did, and the `when` clause keeps it away
 * from the widgets that own Enter (suggestions, snippets, inline suggestions).
 *
 * It exists because a language-configuration `onEnterRules` can only append a
 * fixed string: it cannot count an ordered list up, and it cannot end one. A
 * side effect worth having is that this does not depend on tokenization, while
 * `onEnterRules` is skipped outright until the line has been tokenized -- which
 * is why continuation used to fail for the first moment after a large file
 * opened.
 */
async function continueList(editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  const cursor = editor.selection.active;
  const line = document.lineAt(cursor.line);
  const dialect = DIALECTS.get(document.languageId);
  const item = dialect ? listItem(line.text, dialect) : undefined;
  // Left of the content there is no item to continue yet, only a marker being
  // typed -- and inserting one there would push the marker into its own line.
  const lines = document.getText().split(/\r?\n/);
  const action = dialect && item && editor.selection.isEmpty
      && cursor.character >= item.contentColumn
    ? enterAction(lines, cursor.line, dialect, cursor.character)
    : undefined;
  if (!action) {
    await vscode.commands.executeCommand("type", { text: "\n" });
    return;
  }
  // Every range below is a position in the document as it is now, because a
  // single edit() applies them all against that one snapshot -- which is why
  // the renumbering is computed from the same `lines` the action was.
  const rewrites = action.kind === "continue" && dialect
    ? [...action.also, ...renumberedTail(lines, cursor.line, dialect)]
    : action.also;
  await editor.edit((builder) => {
    if (action.kind === "continue") {
      builder.insert(cursor, `\n${action.text}`);
    } else {
      builder.replace(line.range, action.text);
    }
    apply(builder, rewrites);
  });
}

/** Every span, as ranges in the document the edit is being built against. */
function apply(builder: vscode.TextEditorEdit, rewrites: readonly Rewrite[]): void {
  for (const rewrite of rewrites) {
    builder.replace(
      new vscode.Range(rewrite.line, rewrite.start, rewrite.line, rewrite.end),
      rewrite.text,
    );
  }
}

/**
 * Tab and Shift+Tab over a list item.
 *
 * Bound to Tab, so every case this does not handle has to behave exactly as if
 * it were not bound at all -- hence the fallback to the built-in command
 * rather than an early return. It takes over only while the cursor is still at
 * or left of the item's content: once there is text being typed past the
 * marker, Tab belongs to typing.
 */
async function shiftListItem(
  editor: vscode.TextEditor,
  direction: "indent" | "outdent",
): Promise<void> {
  const fallback = direction === "indent" ? "tab" : "outdent";
  const document = editor.document;
  const cursor = editor.selection.active;
  const item = MARKDOWN_LANGUAGES.has(document.languageId) && editor.selection.isEmpty
    ? listItem(document.lineAt(cursor.line).text)
    : undefined;
  // Read once and only when the key is this command's to take: every other Tab
  // press in a markdown file reaches here too, and splitting the document to
  // decide it is not is work nobody asked for.
  const mine = item !== undefined && cursor.character <= item.contentColumn;
  const lines = mine ? document.getText().split(/\r?\n/) : [];
  const target = mine
    ? (direction === "indent" ? indentTarget : outdentTarget)(lines, cursor.line)
    : undefined;
  if (target === undefined || !item) {
    await vscode.commands.executeCommand(fallback);
    return;
  }
  // Moving an item between two levels leaves both of the ordered lists it
  // touched counting wrong, and they are rewritten in the same edit so the
  // whole move is one undo.
  const renumbers = renumberedAfterMove(lines, cursor.line, target);
  await editor.edit((builder) => {
    builder.replace(
      new vscode.Range(cursor.line, 0, cursor.line, item.indent.length),
      target,
    );
    apply(builder, renumbers);
  });
}

/** The block a previous run wrote, or why there is no usable one. */
function tocRange(
  document: vscode.TextDocument,
): vscode.Range | "unterminated" | undefined {
  const text = document.getText();
  const start = text.indexOf(TOC_START);
  if (start < 0) {
    return undefined;
  }
  const end = text.indexOf(TOC_END, start + TOC_START.length);
  return end < 0
    ? "unterminated"
    : new vscode.Range(
      document.positionAt(start),
      document.positionAt(end + TOC_END.length),
    );
}

async function insertToc(editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  if (!MARKDOWN_LANGUAGES.has(document.languageId)) {
    vscode.window.showWarningMessage(
      `Poly: Insert Table of Contents needs a markdown file (this one is ${document.languageId})`,
    );
    return;
  }
  const lines = toc(document.getText());
  if (lines.length === 0) {
    vscode.window.showWarningMessage(
      "Poly: this document has no headings below its title, so there is nothing to list",
    );
    return;
  }
  const existing = tocRange(document);
  if (existing === "unterminated") {
    // Guessing where the block ends would mean overwriting whatever follows.
    vscode.window.showWarningMessage(
      `Poly: found ${TOC_START} with no ${TOC_END}; add the closing marker or delete the opening one`,
    );
    return;
  }
  const block = [TOC_START, ...lines, TOC_END].join("\n");
  await editor.edit((builder) => {
    if (existing) {
      builder.replace(existing, block);
    } else {
      builder.insert(editor.selection.active, `${block}\n`);
    }
  });
}

/** Run `action` against the active editor, or say why it cannot run. */
function withEditor(
  what: string,
  action: (editor: vscode.TextEditor) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      // Said out loud rather than swallowed: every command here is in the
      // palette, so each can be invoked with no editor at all, and silence
      // reads as a broken command rather than an inapplicable one.
      vscode.window.showWarningMessage(`Poly: ${what} needs an open editor`);
      return;
    }
    await action(editor);
  };
}

/**
 * Indent tinting, wired to the editor.
 *
 * Only the visible lines are decorated. A decoration per indent level over a
 * whole file is thousands of ranges that nobody is looking at, and the events
 * that change what is visible are the same ones that would have to invalidate
 * a cache anyway.
 */
function tintIndentation(context: vscode.ExtensionContext): void {
  const tints = [1, 2, 3, 4].map((n) =>
    vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(`poly.indentLevel${n}`),
    })
  );
  const partial = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("poly.indentPartial"),
  });
  context.subscriptions.push(partial, ...tints);

  const paint = (editor: vscode.TextEditor) => {
    const byLevel: vscode.Range[][] = tints.map(() => []);
    const odd: vscode.Range[] = [];
    const on = vscode.workspace
      .getConfiguration("poly")
      .get<boolean>("indentTint.enabled", true);
    if (on) {
      // `editor.options.tabSize` is what the editor resolved -- from the
      // language, the file, or `editor.detectIndentation` -- so this follows
      // the same width the reader is actually looking at.
      const tabSize = typeof editor.options.tabSize === "number"
        ? editor.options.tabSize
        : 4;
      for (const visible of editor.visibleRanges) {
        for (let line = visible.start.line; line <= visible.end.line; line++) {
          for (const span of indentSpans(editor.document.lineAt(line).text, tabSize)) {
            const range = new vscode.Range(line, span.start, line, span.end);
            if (span.partial) {
              odd.push(range);
            } else {
              byLevel[span.level % byLevel.length].push(range);
            }
          }
        }
      }
    }
    tints.forEach((tint, i) => editor.setDecorations(tint, byLevel[i]));
    editor.setDecorations(partial, odd);
  };

  // Typing produces a change event per keystroke, and repainting on each one
  // is work thrown away by the next. One frame of lag is not visible; the
  // repaints are.
  let pending: NodeJS.Timeout | undefined;
  const repaintAll = () => {
    clearTimeout(pending);
    pending = setTimeout(() => vscode.window.visibleTextEditors.forEach(paint), 50);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(pending) });

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(repaintAll),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => paint(event.textEditor)),
    vscode.window.onDidChangeTextEditorOptions((event) => paint(event.textEditor)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.visibleTextEditors.some((e) => e.document === event.document)) {
        repaintAll();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.indentTint")) {
        repaintAll();
      }
    }),
  );
  vscode.window.visibleTextEditors.forEach(paint);
}

/**
 * The image a line refers to, if exactly one of its candidates is a real file.
 *
 * Resolved against the document's own directory first and the workspace root
 * second, which covers both `./logo.png` next to the file and `/assets/logo.png`
 * written the way a web server will serve it.
 */
function imageOnLine(document: vscode.TextDocument, text: string): string | undefined {
  const here = path.dirname(document.uri.fsPath);
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  for (const reference of imageReferences(text)) {
    const bases = path.isAbsolute(reference.path)
      // An absolute path in source is usually server-absolute, not disk-
      // absolute, so the workspace root is the more useful reading of it --
      // but try the literal one too, because sometimes it is just a path.
      ? [root, undefined]
      : [here, root];
    for (const base of bases) {
      const file = base === undefined
        ? reference.path
        : path.join(base, reference.path.replace(/^[/\\]+/, ""));
      try {
        if (fs.statSync(file).isFile()) {
          return file;
        }
      } catch {
        // Not there. That is the filter, not an error.
      }
    }
  }
  return undefined;
}

/**
 * A thumbnail in the gutter for every visible line that names an image.
 *
 * `gutterIconPath` belongs to the decoration *type*, not to a range, so there
 * has to be one type per distinct image. They are cached across repaints and
 * disposed with the extension; the cache is bounded because a file only has so
 * many visible lines.
 */
function previewImages(context: vscode.ExtensionContext): void {
  const types = new Map<string, vscode.TextEditorDecorationType>();
  context.subscriptions.push({
    dispose: () => types.forEach((type) => type.dispose()),
  });

  const paint = (editor: vscode.TextEditor) => {
    const shown = new Map<string, vscode.Range[]>();
    const on = vscode.workspace
      .getConfiguration("poly")
      .get<boolean>("imagePreview.enabled", true);
    if (on && editor.document.uri.scheme === "file") {
      for (const visible of editor.visibleRanges) {
        for (let line = visible.start.line; line <= visible.end.line; line++) {
          const file = imageOnLine(editor.document, editor.document.lineAt(line).text);
          if (!file) {
            continue;
          }
          if (!types.has(file)) {
            types.set(
              file,
              vscode.window.createTextEditorDecorationType({
                gutterIconPath: vscode.Uri.file(file),
                gutterIconSize: "contain",
              }),
            );
          }
          const ranges = shown.get(file) ?? [];
          ranges.push(new vscode.Range(line, 0, line, 0));
          shown.set(file, ranges);
        }
      }
    }
    // Every known type is set on this editor, including to nothing: a type
    // left alone keeps whatever it was showing the last time this editor
    // scrolled past that line.
    for (const [file, type] of types) {
      editor.setDecorations(type, shown.get(file) ?? []);
    }
  };

  let pending: NodeJS.Timeout | undefined;
  const repaintAll = () => {
    clearTimeout(pending);
    // Slower than the indent repaint on purpose: this one stats files, and
    // nobody needs a thumbnail to keep up with typing.
    pending = setTimeout(() => vscode.window.visibleTextEditors.forEach(paint), 250);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(pending) });

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(repaintAll),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => paint(event.textEditor)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.visibleTextEditors.some((e) => e.document === event.document)) {
        repaintAll();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.imagePreview")) {
        repaintAll();
      }
    }),
  );
  vscode.window.visibleTextEditors.forEach(paint);
}

/**
 * A lens that remembers which declaration it is counting, and what about it.
 *
 * `vscode.CodeLens` carries only a range, and resolution happens later and out
 * of order; the editor hands back the same object, so the uri rides on it.
 *
 * One lens counts one thing, so `N refs | N impls` over a declaration is two of
 * these sharing a range. The editor renders same-range lenses in the order they
 * were provided, which is what puts refs first.
 */
class ReferenceLens extends vscode.CodeLens {
  constructor(
    readonly uri: vscode.Uri,
    readonly counts: "refs" | "impls",
    range: vscode.Range,
  ) {
    super(range);
  }
}

/**
 * How many declarations in one file may carry a lens.
 *
 * A generated protobuf stub is thousands of symbols and a lens each is a wall
 * of grey above code nobody reads. It caps the list, not the cost: the editor
 * resolves only the lenses on screen, which is what keeps this to one reference
 * query per visible declaration rather than one per declaration in the file.
 */
const MAX_LENSES = 300;

/**
 * How many declarations to ask about before deciding nothing can answer.
 *
 * `executeReferenceProvider` asks with `includeDeclaration: true`, so a
 * provider that answers at all answers with at least the declaration itself.
 * Zero locations therefore means "nobody is registered for this language",
 * which is a different thing from "nothing refers to this" -- and the
 * difference is the whole point, because the second one is worth a `no refs`
 * lens and the first one is worth silence.
 *
 * More than one, because the first declaration in a file can legitimately be a
 * position no provider considers a symbol. Three, because this runs on every
 * file that has declarations at all and the answer is the same every time.
 */
const REFERENCE_PROBES = 3;

/**
 * Does anything answer reference queries for this document?
 *
 * This is what replaced the list of language ids this lens used to be limited
 * to (2026-09-04). A list is a guess about somebody else's installed
 * extensions: it left out python, typescript, java and everything else with a
 * perfectly good reference provider, and it would have gone on being wrong as
 * the user's extensions changed. Asking costs one query per file and is right
 * by construction.
 */
async function answersReferences(
  uri: vscode.Uri,
  targets: readonly { readonly symbol: vscode.DocumentSymbol }[],
): Promise<boolean> {
  for (const target of targets.slice(0, REFERENCE_PROBES)) {
    const found = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      uri,
      target.symbol.selectionRange.start,
    );
    if (found && found.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * `N refs` over every declaration and `N impls` over every interface, in every
 * language whose provider can answer.
 *
 * The counts come from `vscode.executeReferenceProvider` and
 * `vscode.executeImplementationProvider`, which is to say from whichever
 * providers are registered — for Go that is poly-lsp's proxy in front of gopls,
 * for TypeScript the built-in server, for Python whatever the user installed.
 * poly analyses nothing here; see `references.ts`.
 *
 * TypeScript and JavaScript used to be held out on the grounds that VSCode
 * ships its own reference lens for them. It does, and it is off by default
 * (`typescript.referencesCodeLens.enabled`), so holding them out meant most
 * people got no lens at all. Someone who turns the built-in one on now gets two
 * counts; that is visible and fixable, unlike the silence it replaced.
 */
function countReferencesInGutter(context: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,

    async provideCodeLenses(document) {
      const config = vscode.workspace.getConfiguration("poly");
      if (!config.get<boolean>("referencesCodeLens.enabled", true)) {
        return [];
      }
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", document.uri);
      // No symbol provider, or one that has not finished loading the project.
      // Either way there is nothing to hang a count on yet.
      if (!symbols) {
        return [];
      }
      const targets = lensTargets(symbols, MAX_LENSES);
      // Before any lens is drawn, because a file full of `no refs` over a
      // language nothing can answer for is worse than no lens: it reads as an
      // answer. JSON and markdown never reach here (their symbols are not the
      // kinds this counts); CSS and YAML do, and this is what decides them.
      if (targets.length === 0 || !(await answersReferences(document.uri, targets))) {
        return [];
      }
      return targets.flatMap((target) => {
        const range = target.symbol.selectionRange;
        const lenses = [new ReferenceLens(document.uri, "refs", range)];
        if (target.implementable) {
          lenses.push(new ReferenceLens(document.uri, "impls", range));
        }
        return lenses;
      });
    },

    async resolveCodeLens(lens) {
      const { uri: at, counts } = lens as ReferenceLens;
      const start = lens.range.start;
      const found = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >(
        counts === "refs"
          ? "vscode.executeReferenceProvider"
          : "vscode.executeImplementationProvider",
        at,
        start,
      );
      // A reference provider answers in `Location`s, an implementation provider
      // may answer in `LocationLink`s, and the command below only understands
      // the first.
      const locations = (found ?? []).map((one) =>
        "targetUri" in one
          ? new vscode.Location(
            one.targetUri,
            one.targetSelectionRange ?? one.targetRange,
          )
          : one
      );
      const count = countElsewhere(
        locations.map((location) => ({
          uri: location.uri.toString(),
          line: location.range.start.line,
        })),
        { uri: at.toString(), line: start.line },
      );
      lens.command = {
        title: counts === "refs" ? refLabel(count) : implLabel(count),
        // The built-in references-view activates on this command and shows its
        // tree instead of the peek when `references.preferredLocation` is
        // "view", so the user's own setting decides which one opens rather than
        // poly picking for them. It is the command VSCode's own TypeScript
        // reference lens uses, and that setting exists to steer exactly this.
        // Nothing to open when nothing refers to it, so the lens is text.
        command: count > 0 ? "editor.action.showReferences" : "",
        arguments: [at, start, locations],
      };
      return lens;
    },
  };

  context.subscriptions.push(
    changed,
    // Every file scheme, filtered by language inside: the setting is a list of
    // language ids, and a selector built from it at registration time would go
    // stale the moment it changed.
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.referencesCodeLens")) {
        changed.fire();
      }
    }),
  );
}

/**
 * A snippet built from a template, with the user's text escaped into it.
 *
 * The two halves go in differently on purpose: the template's `$0` and
 * `${1:name}` are ours and must stay live, while the expression came off the
 * user's line and a `$` or `}` in it must not become snippet syntax.
 */
function postfixSnippet(template: string, expression: string): vscode.SnippetString {
  const snippet = new vscode.SnippetString();
  template.split(EXPR_MARK).forEach((chunk, index) => {
    if (index > 0) {
      snippet.appendText(expression);
    }
    snippet.value += chunk;
  });
  return snippet;
}

/**
 * `err.if` → `if err != nil { }`, in every language that has statements.
 *
 * See `postfix.ts` for the templates and for why a text rearrangement is not
 * the language feature 01 A6 rules out. Nothing here asks anything of a
 * language server: it is the characters left of the dot and a table.
 */
function completePostfixes(context: vscode.ExtensionContext): void {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position) {
      const on = vscode.workspace
        .getConfiguration("poly")
        .get<boolean>("postfixCompletion.enabled", true);
      const postfixes = on ? postfixesFor(document.languageId) : undefined;
      if (!postfixes) {
        return undefined;
      }
      const line = document.lineAt(position.line).text;
      const target = postfixTarget(line, position.character);
      if (!target) {
        return undefined;
      }
      // From the start of the expression, because the expansion moves it: the
      // item replaces `resp.Body.if`, not just the `if`.
      const range = new vscode.Range(
        position.line,
        target.start,
        position.line,
        position.character,
      );
      return postfixes.map((postfix) => {
        const item = new vscode.CompletionItem(
          postfix.name,
          vscode.CompletionItemKind.Snippet,
        );
        item.range = range;
        item.insertText = postfixSnippet(postfix.template, target.expression);
        item.detail = describe(postfix.template, target.expression);
        // The editor filters against the text the range covers, which is
        // `resp.Body.if` and not `if` -- without this the item disappears the
        // moment the user types the first letter of its own name.
        item.filterText = `${target.expression}.${postfix.name}`;
        // After whatever the language server offered. A member named `iffy`
        // is a real answer about the program; this is a template, and the
        // template only wins once the user has typed something no member
        // matches.
        item.sortText = `zzz${postfix.name}`;
        return item;
      });
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      POSTFIX_LANGUAGES.map((language) => ({ scheme: "file", language })),
      provider,
      ".",
    ),
  );
}

/**
 * As much of the built-in git extension's API as the two commands below need.
 *
 * Declared here rather than pulled in from `@types/vscode.git`: this is four
 * fields, and the alternative is a dependency whose whole job is to describe an
 * extension that may not even be enabled.
 */
interface GitChange {
  readonly uri: vscode.Uri;
}
interface GitRepository {
  readonly state: {
    readonly workingTreeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
  };
}
interface GitExtension {
  getAPI(version: 1): { readonly repositories: readonly GitRepository[] };
}

/** Every path git reports as changed, across all open repositories. */
async function changedFiles(): Promise<string[] | undefined> {
  const git = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!git) {
    return undefined;
  }
  const exports = git.isActive ? git.exports : await git.activate();
  return exports.getAPI(1).repositories.flatMap((repo) =>
    [...repo.state.workingTreeChanges, ...repo.state.indexChanges]
      // Staged deletions and merge conflicts show up here too; a path with no
      // file behind it would open an empty editor.
      .filter((change) => change.uri.scheme === "file")
      .map((change) => change.uri.fsPath)
  );
}

/**
 * Open the next (or previous) file with changes and land on a change in it.
 *
 * VSCode has next/previous change within a file and a list of changed files in
 * the SCM view; what it has no command for is the step between two files, which
 * is the one a review pass makes most often.
 */
async function stepChangedFile(direction: 1 | -1): Promise<void> {
  const files = await changedFiles();
  if (files === undefined) {
    vscode.window.showWarningMessage(
      "Poly: the built-in git extension is disabled, so there are no changes to walk",
    );
    return;
  }
  const here = vscode.window.activeTextEditor?.document.uri;
  const target = nextChangedFile(
    files,
    here?.scheme === "file" ? here.fsPath : undefined,
    direction,
  );
  if (target === undefined) {
    vscode.window.setStatusBarMessage("Poly: no changed files", 3000);
    return;
  }

  const editor = await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(target),
  );
  // The quick diff for a file that was not open yet is computed asynchronously,
  // and the built-in navigation does nothing while it has no changes -- so a
  // single call would leave the cursor at the top of the file it just opened,
  // which is the one place we know the change is not. Retry briefly instead of
  // guessing a delay long enough to always work.
  const command = direction === 1
    ? "workbench.action.editor.nextChange"
    : "workbench.action.editor.previousChange";
  const before = editor.selection.active;
  for (let attempt = 0; attempt < 10; attempt++) {
    await vscode.commands.executeCommand(command);
    if (!editor.selection.active.isEqual(before)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * How many of the offered actions to have the provider resolve.
 *
 * `executeCodeActionProvider` hands back unresolved actions unless it is given
 * a count, and an unresolved action has no `edit` -- rust-analyzer in
 * particular computes edits only on resolve, because computing all of them up
 * front is the expensive thing. The cap keeps that from being unbounded; with
 * an `only` filter this narrow, no server measured offers close to it.
 */
const MAX_RESOLVED = 32;

/**
 * Run the extract- or inline-variable refactoring, without the menu.
 *
 * The work is the language server's; see `refactors.ts` for why choosing among
 * its answers is a thing poly may do. Applying is in two halves because an
 * action may carry an edit, a command, or both, and VSCode's own code-action
 * runner applies them in that order -- a server that returns both means the
 * command to run *after* the edit lands.
 */
async function runRefactor(
  editor: vscode.TextEditor,
  want: Refactoring,
  what: string,
): Promise<void> {
  // An empty selection is the common case for inline (the cursor is on the
  // binding) and a mistake for extract, but the word under the cursor is a
  // legal expression to extract and is what `editor.action.refactor` would
  // have offered from the same position. Guessing wider than one word would be
  // poly deciding where an expression begins, which is the language's job.
  const range = editor.selection.isEmpty
    ? editor.document.getWordRangeAtPosition(editor.selection.active)
      ?? editor.selection
    : editor.selection;

  const offered = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    editor.document.uri,
    range,
    REFACTOR_KIND[want],
    MAX_RESOLVED,
  );
  const choices = refactorChoices(
    (offered ?? []).map((action) => ({
      action,
      title: action.title,
      kind: action.kind?.value,
    })),
    want,
  );
  if (choices.length === 0) {
    // Named rather than generic: "nothing here" and "this language server does
    // not do this" look identical from the outside, and the selection is the
    // half the user can change.
    vscode.window.showWarningMessage(
      `Poly: no ${what} offered at this selection — select an expression, or this language's server has none.`,
    );
    return;
  }
  const chosen = choices.length === 1
    ? choices[0]
    : await vscode.window.showQuickPick(
      choices.map((one) => ({ label: one.action.title, one })),
      { title: `Poly: ${what}`, placeHolder: "More than one applies here" },
    ).then((picked) => picked?.one);
  if (!chosen) {
    return;
  }
  if (chosen.action.edit) {
    await vscode.workspace.applyEdit(chosen.action.edit);
  }
  if (chosen.action.command) {
    await vscode.commands.executeCommand(
      chosen.action.command.command,
      ...(chosen.action.command.arguments ?? []),
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  tintIndentation(context);
  previewImages(context);
  countReferencesInGutter(context);
  completePostfixes(context);
  registerTodoTree(context);

  const commands: [string, () => Promise<void>][] = [
    [
      "poly.copyPathWithLine",
      withEditor("Copy Path with Line Numbers", async (editor) => {
        const text = reference(editor);
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(`Copied ${text}`, 3000);
      }),
    ],
    [
      "poly.insertTableOfContents",
      withEditor("Insert Table of Contents", insertToc),
    ],
    [
      "poly.toggleBold",
      withEditor("Toggle Bold", (editor) => toggleEmphasis(editor, "**")),
    ],
    [
      "poly.toggleItalic",
      withEditor("Toggle Italic", (editor) => toggleEmphasis(editor, "_")),
    ],
    [
      "poly.extractVariable",
      withEditor(
        "Extract Variable",
        (editor) => runRefactor(editor, "extract", "extract-variable refactoring"),
      ),
    ],
    [
      "poly.inlineVariable",
      withEditor(
        "Inline Variable",
        (editor) => runRefactor(editor, "inline", "inline-variable refactoring"),
      ),
    ],
    [
      "poly.continueList",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await continueList(editor);
        }
      },
    ],
    [
      "poly.indentListItem",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await shiftListItem(editor, "indent");
        }
      },
    ],
    [
      "poly.outdentListItem",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await shiftListItem(editor, "outdent");
        }
      },
    ],
    ["poly.nextChangedFile", () => stepChangedFile(1)],
    ["poly.previousChangedFile", () => stepChangedFile(-1)],
    [
      "poly.revertAndSave",
      withEditor("Revert and Save", async () => {
        // Both halves are built in; what is missing is that they are one
        // gesture. Reverting a hunk and leaving the file dirty means the next
        // save is what actually decides, so the undo is only half done until a
        // second keystroke -- and the file on disk disagrees with the editor in
        // between.
        await vscode.commands.executeCommand("git.revertSelectedRanges");
        await vscode.commands.executeCommand("workbench.action.files.save");
      }),
    ],
  ];
  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
}

export function deactivate() {}
