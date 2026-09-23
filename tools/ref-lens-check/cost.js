// What the reference lens costs the language server behind it.
//
// "Showing refs is slow and eats resources" was reported against real gopls,
// and every question poly's lens asks lands on that server. The rest of this
// check asks where lenses land; this part counts how often they ask, which is
// the half a user pays for. It is counted rather than timed: a real server's
// latency depends on the project and the machine, but the number of questions
// poly puts to it for one open, one burst of typing and one scroll is poly's
// own doing and the same on every machine.
//
// The providers here are poly's only audience: plaintext has no built-in
// symbol or reference provider, so every call they count came from poly. Each
// answers after a delay, because a real server does and the editor behaves
// differently towards an answer that is not already there -- a lens superseded
// while its query is still running is exactly the case being measured.
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const vscode = require("vscode");

/** How long each fake answer takes: a fast gopls on a small module. */
const ANSWER_MS = 30;

/** Declarations in the fixture, two lines apart so most of them are on screen. */
const DECLARATIONS = 30;

/** Files the clicked result set spreads over, two hits each. */
const HIT_FILES = 20;

/**
 * The fixture's outline: three interfaces, five classes and the rest
 * functions, so both implementation directions are probed and neither ever
 * answers -- TypeScript's "up" never does, and that is the costly path.
 */
function outline() {
  return Array.from({ length: DECLARATIONS }, (_, index) => {
    const line = index * 2;
    const kind = index < 3
      ? vscode.SymbolKind.Interface
      : index < 8
      ? vscode.SymbolKind.Class
      : vscode.SymbolKind.Function;
    const name = `decl${index}`;
    const whole = new vscode.Range(line, 0, line, name.length);
    return new vscode.DocumentSymbol(name, "", kind, whole, whole);
  });
}

function later(value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ANSWER_MS));
}

/** Resolves once no counter has moved for `quietMs`, or after `capMs`. */
async function settle(calls, quietMs = 2_000, capMs = 30_000) {
  const deadline = Date.now() + capMs;
  let last = JSON.stringify(calls);
  let since = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const now = JSON.stringify(calls);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
  }
}

function delta(before, after) {
  return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)]));
}

exports.measure = async function measure(workspace) {
  const dir = join(workspace, "cost");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "cost.txt");
  const lines = Array.from({ length: DECLARATIONS * 2 }, (_, index) => index % 2 === 0 ? `decl${index / 2}` : "");
  writeFileSync(file, `${lines.join("\n")}\ncalled here\n`);
  const uri = vscode.Uri.file(file);
  const hits = [];
  for (let index = 0; index < HIT_FILES; index++) {
    const other = join(dir, `hit${index}.txt`);
    writeFileSync(other, "one\ncalls decl0\nand decl0 again\n");
    hits.push(
      new vscode.Location(vscode.Uri.file(other), new vscode.Range(1, 6, 1, 11)),
      new vscode.Location(vscode.Uri.file(other), new vscode.Range(2, 4, 2, 9)),
    );
  }

  const calls = { symbols: 0, references: 0, implementations: 0, opened: 0 };
  const selector = { scheme: "file", language: "plaintext" };
  const disposables = [
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols(document) {
        calls.symbols++;
        return document.uri.toString() === uri.toString() ? later(outline()) : later([]);
      },
    }),
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences(document, position) {
        calls.references++;
        // The declaration and forty uses in twenty other files, as a server
        // that answers at all does. The lens only counts them; the click is
        // the one gesture that opens anything.
        return later([new vscode.Location(document.uri, new vscode.Range(position, position)), ...hits]);
      },
    }),
    vscode.languages.registerImplementationProvider(selector, {
      provideImplementation() {
        calls.implementations++;
        return later([]);
      },
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.fsPath.startsWith(dir)) calls.opened++;
    }),
  ];

  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const phases = {};
  let before = { ...calls };

  const started = Date.now();
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await settle(calls);
  phases.open = { ...delta(before, calls), visibleLines: editor.visibleRanges[0]?.end.line ?? null };
  before = { ...calls };

  // A burst of typing that changes no declaration: five keystrokes at a
  // typist's pace, on the last line. Every one of them is a document version.
  for (let index = 0; index < 5; index++) {
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    await editor.edit((edit) => edit.insert(end, "x"));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await settle(calls);
  phases.typing = delta(before, calls);
  before = { ...calls };

  editor.revealRange(
    new vscode.Range(DECLARATIONS * 2 - 1, 0, DECLARATIONS * 2 - 1, 0),
    vscode.TextEditorRevealType.AtTop,
  );
  await settle(calls);
  editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
  await settle(calls);
  phases.scroll = delta(before, calls);
  before = { ...calls };

  // The click on a lens with forty hits in twenty files.
  const clicked = Date.now();
  await vscode.commands.executeCommand("poly.showReferences", uri, new vscode.Position(0, 0), "refs");
  phases.click = { ...delta(before, calls), ms: Date.now() - clicked };
  await settle(calls);
  phases.clickSettled = delta(before, calls);

  for (const disposable of disposables) disposable.dispose();
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  return {
    answerMs: ANSWER_MS,
    declarations: DECLARATIONS,
    hitFiles: HIT_FILES,
    totalMs: Date.now() - started,
    phases,
  };
};
