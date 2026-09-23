import * as vscode from "vscode";

import { enclosing, rowPrefix, TreeSymbol } from "./referenceRows";

/** A file with hits in it, or one hit. */
type Node =
  | { kind: "file"; file: File }
  | { kind: "row"; uri: vscode.Uri; row: Row };

interface File {
  readonly uri: vscode.Uri;
  readonly rows: Row[];
  /** Open when the list appears, rather than folded under its name. */
  readonly expanded: boolean;
  /** The kind column, asked for once and only when the file is unfolded. */
  labelled?: Promise<void>;
}

interface Row {
  readonly range: vscode.Range;
  /** The line's own source, trimmed -- what the built-in tree shows. */
  readonly text: string;
  /** `func handle`, `var config`, or empty for a hit inside nothing or not yet asked. */
  kind: string;
  /** 1-based, as printed. */
  readonly number: string;
}

/**
 * How many files' outlines are fetched to label the rows.
 *
 * A symbol query per file, and a reference search over a monorepo can return
 * hits in hundreds. The rows beyond the cap still appear with their line
 * numbers -- what they lose is the kind column, which is the part that costs a
 * round trip to a language server.
 */
const MAX_OUTLINES = 60;

/**
 * How many files arrive unfolded.
 *
 * An unfolded file is an outline request, and an outline request opens the
 * file in every language server the window runs -- measured 2026-09-23, a
 * click on forty hits in twenty files opened all twenty and took 718ms before
 * the list appeared. The first ten are the ones on screen anyway; the rest ask
 * when somebody unfolds them.
 */
const MAX_EXPANDED = 10;

/**
 * poly's own references tree.
 *
 * It exists because `references-view` is a different extension and a
 * `TreeDataProvider` owns its rows: there is no contribution point for "add a
 * column to that tree". What this adds is the line number and the enclosing
 * symbol, which is the whole reason to have a second one -- everything else
 * here is the built-in tree's behaviour reimplemented to keep it.
 *
 * Nothing is computed until a lens is clicked. The view holds one result set at
 * a time, the way the built-in one does, because a reference search is a
 * question asked about a cursor and keeping the last five answers around would
 * mean five stale ones.
 */
export class ReferenceTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private files: File[] = [];

  /** Outlines asked for since the list was filled; see `MAX_OUTLINES`. */
  private outlines = 0;

  /** What the view's title should say it is showing. */
  summary = "";

  async show(what: string, locations: readonly vscode.Location[]): Promise<void> {
    const byFile = new Map<string, vscode.Location[]>();
    for (const location of locations) {
      const key = location.uri.toString();
      const hits = byFile.get(key);
      if (hits) {
        hits.push(location);
      } else {
        byFile.set(key, [location]);
      }
    }

    const found: { uri: vscode.Uri; rows: Row[] }[] = [];
    for (const [key, hits] of byFile) {
      const uri = vscode.Uri.parse(key);
      const lines = await linesOf(uri);
      if (!lines) {
        // Deleted or unreadable between the search and now. One file missing is
        // not a reason to show none of the others.
        continue;
      }
      const rows = hits
        .map((hit) => ({
          range: hit.range,
          text: (lines[hit.range.start.line] ?? "").trim(),
          kind: "",
          number: `${hit.range.start.line + 1}`,
        }))
        .sort((a, b) => a.range.start.line - b.range.start.line);
      found.push({ uri, rows });
    }
    found.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));

    this.outlines = 0;
    this.files = found.map((file, index) => ({ ...file, expanded: index < MAX_EXPANDED }));
    const hits = found.reduce((n, file) => n + file.rows.length, 0);
    this.summary = `${what} — ${hits} in ${found.length} file${found.length === 1 ? "" : "s"}`;
    // The view is hidden until there is something in it. An always-present
    // "References" panel sitting empty in the Explorer is a row of chrome for a
    // feature most sessions never use, and the reference lens is off by default
    // -- so for most people the view would never fill in at all.
    await vscode.commands.executeCommand("setContext", "poly.hasReferences", true);
    this.changed.fire();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.files.map((file) => ({ kind: "file", file }));
    }
    if (node.kind !== "file") {
      return [];
    }
    const { file } = node;
    // Asked here and not in `show`, because this is the moment the rows are
    // about to be looked at: a folded file never asks, and a file unfolded
    // twice asks once.
    file.labelled ??= this.label(file);
    await file.labelled;
    return file.rows.map((row) => ({ kind: "row", uri: file.uri, row }));
  }

  /**
   * What the view shows, as data.
   *
   * For the checks that click a lens and need to know where it went: a tree's
   * rows are not readable from outside the extension that owns it, and the
   * only other witness is a screenshot. Folded files come back without their
   * kind column, exactly as they are on screen.
   */
  shown(): { summary: string; files: { path: string; rows: { line: number; text: string; kind: string }[] }[] } {
    return {
      summary: this.summary,
      files: this.files.map((file) => ({
        path: file.uri.fsPath,
        rows: file.rows.map((row) => ({ line: row.range.start.line, text: row.text, kind: row.kind })),
      })),
    };
  }

  private async label(file: File): Promise<void> {
    if (this.outlines++ >= MAX_OUTLINES) {
      return;
    }
    const symbols = await outlineOf(file.uri);
    for (const row of file.rows) {
      row.kind = rowPrefix(row.range.start.line, enclosing(symbols, row.range.start.line)).kind;
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "file") {
      const { file } = node;
      const item = new vscode.TreeItem(
        vscode.workspace.asRelativePath(file.uri),
        file.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${file.rows.length}`;
      item.resourceUri = file.uri;
      item.iconPath = vscode.ThemeIcon.File;
      return item;
    }
    const { row } = node;
    // The line number leads, because it is what the eye scans down and what a
    // `path:line` reference needs. The code is the label rather than the
    // description so that the tree's own filter box searches it.
    const item = new vscode.TreeItem(
      `${row.number}  ${row.text}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = row.kind;
    item.tooltip = row.kind
      ? `${vscode.workspace.asRelativePath(node.uri)}:${row.number} — in ${row.kind}`
      : `${vscode.workspace.asRelativePath(node.uri)}:${row.number}`;
    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [
        node.uri,
        { selection: row.range } satisfies vscode.TextDocumentShowOptions,
      ],
    };
    return item;
  }
}

/**
 * A file's lines, without opening it.
 *
 * `openTextDocument` would be simpler and is what this used to do, but an open
 * document is announced to every language server in the window -- a `didOpen`
 * that gopls, rust-analyzer and poly's own linter each act on -- to print one
 * line of it. A document already open is read from the editor instead, so the
 * row shows what is on screen rather than what was last saved.
 */
async function linesOf(uri: vscode.Uri): Promise<string[] | undefined> {
  const open = vscode.workspace.textDocuments.find((one) => one.uri.toString() === uri.toString());
  if (open) {
    return open.getText().split(/\r?\n/);
  }
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/**
 * A file's outline, or nothing.
 *
 * Nothing is the answer for every language with no symbol provider installed,
 * which is most of them in most windows -- so it is a row without a kind
 * column, not an error and not an empty tree.
 */
async function outlineOf(uri: vscode.Uri): Promise<TreeSymbol[]> {
  let symbols: vscode.DocumentSymbol[] | undefined;
  try {
    symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      uri,
    );
  } catch {
    return [];
  }
  // No shape check, and that is measured rather than assumed. A provider may
  // answer in either of the two symbol shapes -- bash-language-server sends the
  // flat `SymbolInformation`, gopls the nested `DocumentSymbol` --  but
  // `executeDocumentSymbolProvider` normalises before handing anything back, so
  // both arrive carrying `range`. `tools/ref-lens-check` pins that with a
  // provider that really answers in the old shape; a conversion here would be a
  // branch nothing can reach.
  const convert = (level: readonly vscode.DocumentSymbol[]): TreeSymbol[] =>
    level.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      startLine: symbol.range.start.line,
      endLine: symbol.range.end.line,
      children: symbol.children && convert(symbol.children),
    }));
  return symbols ? convert(symbols) : [];
}

export function registerReferenceTree(
  context: vscode.ExtensionContext,
): ReferenceTree {
  const tree = new ReferenceTree();
  const view = vscode.window.createTreeView("polyReferences", {
    treeDataProvider: tree,
  });
  context.subscriptions.push(
    view,
    tree.onDidChangeTreeData(() => {
      view.description = tree.summary;
    }),
    // Not contributed, like the lens clicks: nothing in it is for a person.
    // tools/ref-lens-check and tools/ext-diff read the list through it.
    vscode.commands.registerCommand("poly.referencesShown", () => tree.shown()),
  );
  return tree;
}
