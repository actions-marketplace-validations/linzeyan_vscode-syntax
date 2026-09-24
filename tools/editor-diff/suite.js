// Runs inside a real extension host with poly loaded from source and the
// extensions it replaces installed beside it, asks both the same question, and
// writes down where the answers differ.
//
// This is an audit, not a gate: it is the only way to check poly against
// the thing it replaced, and it is the only thing in this repo that needs the
// marketplace. The editor features' own tests stay where 08 §9 put them -- pure
// modules under node's test runner.
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const vscode = require("vscode");

const { CASES } = require("./cases.js");

/**
 * This repo's table, then markdown-all-in-one's own, fetched and parsed by
 * run.js because the host has no network. Theirs carry `marks` instead of a
 * marked-up string: their tests already say where the cursor is, and
 * round-tripping that through `|` would only invent a way to get it wrong.
 */
function allCases() {
  const corpus = process.env.POLY_DIFF_CORPUS;
  if (!corpus || !existsSync(corpus)) return CASES;
  return [...CASES, ...JSON.parse(readFileSync(corpus, "utf8"))];
}

const REQUIRED = [
  "ricky.poly-lsp",
  "yzhang.markdown-all-in-one",
  "ezforo.copy-relative-path-and-line-numbers",
];

/**
 * `|` is the cursor; `«`...`»` a selection. The guillemets are not `[`...`]`
 * for a reason found the hard way: `- [x] alpha` is a task list item, and
 * reading its brackets as markers turned that case into a different document.
 */
function parseMarkers(marked) {
  const open = marked.indexOf("«");
  const close = marked.indexOf("»");
  if (open >= 0 && close > open) {
    const text = marked.replace("«", "").replace("»", "").replace("|", "");
    return { text, anchor: offsetToPosition(text, open), active: offsetToPosition(text, close - 1) };
  }
  const caret = marked.indexOf("|");
  const text = marked.replace("|", "");
  const at = offsetToPosition(text, caret < 0 ? 0 : caret);
  return { text, anchor: at, active: at };
}

function offsetToPosition(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Whether a user editing this language could reach `command` at all.
 *
 * `executeCommand` ignores the `when` clause a keybinding carries, so calling
 * markdown-all-in-one's Enter handler directly makes it answer for languages it
 * would never be bound to -- and the comparison then says the two agree about a
 * file where only one of them ever runs. A command in `contributes.commands` is
 * reachable from the palette in any language; one that exists only as a
 * keybinding is reachable only where its `editorLangId` clause matches.
 */
function reachable(extensionId, command, language) {
  const pkg = vscode.extensions.getExtension(extensionId).packageJSON;
  if ((pkg.contributes.commands ?? []).some((c) => c.command === command)) return true;
  const bindings = (pkg.contributes.keybindings ?? []).filter((k) => k.command === command);
  if (bindings.length === 0) return false;
  return bindings.some((k) => {
    const clause = /editorLangId\s*=~\s*\/([^/]+)\//.exec(k.when ?? "");
    if (clause) return new RegExp(clause[1]).test(language);
    const equality = /editorLangId\s*==\s*'([^']+)'/.exec(k.when ?? "");
    if (equality) return equality[1] === language;
    return true; // no language clause at all: bound everywhere
  });
}

/**
 * Run `command` and wait for it to land. A command that edits the document
 * bumps its version; one that only writes the clipboard never will, so this
 * settles on a short timeout rather than failing -- what it must not do is read
 * the document before the edit arrives and call that "no change".
 */
async function runAndSettle(editor, command) {
  const before = editor.document.version;
  try {
    await vscode.commands.executeCommand(command);
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
  for (let i = 0; i < 40 && editor.document.version === before; i++) await wait(10);
  await wait(30); // a second edit in the same handler (marker + renumber)
  return {};
}

function snapshot(editor) {
  const s = editor.selection;
  return {
    text: editor.document.getText(),
    selection: `${s.anchor.line}:${s.anchor.character}-${s.active.line}:${s.active.character}`,
  };
}

async function reset(editor, text, marks) {
  const all = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(editor.document.getText().length),
  );
  await editor.edit((b) => b.replace(all, text));
  editor.selection = new vscode.Selection(
    new vscode.Position(marks.anchor.line, marks.anchor.character),
    new vscode.Position(marks.active.line, marks.active.character),
  );
}

async function run() {
  const folder = vscode.workspace.workspaceFolders[0].uri;

  // A side that never activated answers nothing, and "nothing" compares equal
  // to "nothing" -- the vacuum check this repo keeps finding. Fail before the
  // first case rather than reporting 20 agreements nobody made.
  for (const id of REQUIRED) {
    const extension = vscode.extensions.getExtension(id);
    if (!extension) throw new Error(`${id} is not installed in this host`);
    await extension.activate();
  }

  const results = [];
  const cases = allCases();
  for (const test of cases) {
    const marks = test.marks
      ? { text: test.text, ...test.marks }
      : parseMarkers(test.text);
    const file = vscode.Uri.joinPath(folder, `${test.id.replace(/\W+/g, "-")}.md`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(marks.text, "utf8"));
    let doc = await vscode.workspace.openTextDocument(file);
    if (doc.languageId !== test.language) {
      doc = await vscode.languages.setTextDocumentLanguage(doc, test.language);
    }
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    if (doc.languageId !== test.language) {
      // Setting the language is the setup, and a comparison run on the wrong
      // one is worse than no comparison: it still looks like a result.
      throw new Error(`${test.id}: opened as ${doc.languageId}, not ${test.language}`);
    }

    const owner = {
      original: test.originalFrom ?? "yzhang.markdown-all-in-one",
      poly: "ricky.poly-lsp",
    };
    const sides = {};
    for (const which of ["original", "poly"]) {
      if (!reachable(owner[which], test[which], test.language)) {
        // Not a result and not an error: a user editing this language never had
        // this command on that key, so there is nothing to compare against.
        sides[which] = { unreachable: true, text: marks.text, selection: "", clipboard: "" };
        continue;
      }
      const once = async () => {
        await reset(editor, marks.text, marks);
        await vscode.env.clipboard.writeText("");
        const failure = await runAndSettle(editor, test[which]);
        return {
          ...snapshot(editor),
          ...failure,
          clipboard: test.reads === "clipboard" ? await vscode.env.clipboard.readText() : undefined,
        };
      };
      let side = await once();
      // `vscode.env.clipboard` is the machine's clipboard, not the test's, so
      // anything else that copies while this runs lands here instead of the
      // command's output. Observed once: a browser URL in place of the path.
      // A reference always names the file it points at, which is enough to tell
      // a foreign value from a disagreement worth reporting.
      const base = file.path.split("/").pop();
      for (let i = 0; i < 2 && test.reads === "clipboard" && !side.clipboard.includes(base); i++) {
        console.log(`       retrying ${test.id} [${which}]: clipboard held something else`);
        side = await once();
      }
      sides[which] = side;
    }

    const key = (side) =>
      side.unreachable
        ? " unreachable"
        : test.reads === "clipboard"
        ? side.clipboard
        : `${side.text} ${side.selection}`;
    results.push({
      id: test.id,
      language: test.language,
      expect: test.expect,
      differs: key(sides.original) !== key(sides.poly),
      original: sides.original,
      poly: sides.poly,
    });
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }

  const out = process.env.POLY_DIFF_OUT || join(folder.fsPath, "editor-diff.json");
  writeFileSync(out, JSON.stringify(results, null, 2));

  const show = (s) => s.unreachable ? "(not bound for this language)" : JSON.stringify(s.clipboard ?? s.text);
  let unexpected = 0;
  for (const r of results) {
    const wanted = r.expect === "same" ? !r.differs : r.differs;
    const mark = wanted ? "ok  " : "FAIL";
    if (!wanted) unexpected++;
    console.log(`${mark} ${r.id} [${r.language}] ${r.differs ? "differs" : "identical"}`);
    if (!wanted || r.differs) {
      console.log(`       expected: ${r.expect}`);
      console.log(`       original: ${show(r.original)}${r.original.error ? ` !${r.original.error}` : ""}`);
      console.log(`       poly    : ${show(r.poly)}${r.poly.error ? ` !${r.poly.error}` : ""}`);
      if (r.differs && !r.original.clipboard) {
        console.log(`       selection: original ${r.original.selection}, poly ${r.poly.selection}`);
      }
    }
  }
  console.log(`\n${results.length} cases, ${unexpected} unexpected`);
  // Both extensions hand the cases they decline back to the editor's own Tab,
  // and `CoreEditingCommands.Tab` is guarded by `editorTextFocus` -- so if this
  // window lost focus while the suite ran, every one of those cases quietly
  // compares "neither side did anything" and agrees for the wrong reason. One
  // run of this suite did exactly that. `tab/not-a-list-at-all` is the probe:
  // nothing in poly or the original handles it, so the editor's own Tab is the
  // only thing that can have changed it.
  const probe = results.find((r) => r.id === "tab/not-a-list-at-all");
  if (probe && !probe.poly.text.includes("plain  ")) {
    console.log(
      "WARNING: the editor's own Tab never fired (window not focused?), so every"
        + " case that falls through to it proved nothing this run",
    );
  }
  if (unexpected) {
    // Both directions are a finding: a case that should agree and does not is a
    // defect, and a case that should differ and does not means poly gave up an
    // improvement it was written to have.
    throw new Error(`${unexpected} case(s) did not match what poly set out to do`);
  }
}

module.exports = { run };
