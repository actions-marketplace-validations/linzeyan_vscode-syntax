// Where poly's reference lens actually lands, asked of a real language server.
//
// The unit tests hand `lensTargets` a symbol tree this repo wrote, so they can
// only be as right as the assumption behind them -- and that assumption is
// exactly what was wrong: parameters and locals arrive as `Variable` children
// of the declaration they sit in, which no hand-written fixture had said. The
// only way to hold that down is to ask a server that really reports symbols.
//
// TypeScript, because it is the one real provider a test host has offline:
// VSCode ships it, so this needs no marketplace extension and no network. What
// it pins is the shape every server shares -- a declaration's body is full of
// names, and none of them is a declaration another file can reach.
const { writeFileSync } = require("node:fs");

const vscode = require("vscode");

/** Long enough for the TypeScript server to load the file, then give up. */
const READY_MS = 60_000;

async function lensesFor(uri) {
  const deadline = Date.now() + READY_MS;
  let lenses = [];
  let settled = 0;
  // Until the count stops changing, not until the first lens appears. poly's
  // lens is published as soon as the document has symbols; TypeScript's waits
  // for the project, and returning early reported that the editor places no
  // reference lens at all -- which is the claim this check exists to test.
  while (Date.now() < deadline && settled < 6) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const now = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri, 50) ?? [];
    settled = now.length > 0 && now.length === lenses.length ? settled + 1 : 0;
    lenses = now;
  }
  return lenses;
}

exports.run = async function run() {
  await vscode.extensions.getExtension("ricky.poly-editor").activate();

  const uri = vscode.Uri.file(process.env.POLY_LENS_FIXTURE);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);

  const lenses = await lensesFor(uri);
  // Both providers publish into the same list, and the workspace turns the
  // editor's own TypeScript lens on: "where does VSCode put one" is the only
  // outside opinion available about where a reference count belongs. They are
  // told apart by what they say -- poly counts "refs" and "impls", TypeScript
  // counts "references".
  const byLine = new Map();
  for (const lens of lenses) {
    const title = lens.command?.title ?? "(unresolved)";
    const line = lens.range.start.line;
    const entry = byLine.get(line) ?? { poly: [], typescript: [] };
    entry[/references?$/.test(title) ? "typescript" : "poly"].push(title);
    byLine.set(line, entry);
  }

  // What the server called each of them. The rule is written in symbol kinds,
  // so a lens in the wrong place is only half a finding until the kind that put
  // it there is on the record -- an enum member reported as `Constant` and one
  // reported as `EnumMember` are two different bugs, or none.
  const kinds = new Map();
  const collect = (symbols) => {
    for (const symbol of symbols ?? []) {
      kinds.set(symbol.selectionRange.start.line, vscode.SymbolKind[symbol.kind]);
      collect(symbol.children);
    }
  };
  collect(await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri));

  const lines = [...byLine.keys()].sort((a, b) => a - b).map((line) => ({
    line,
    text: document.lineAt(line).text.trim(),
    kind: kinds.get(line) ?? "(not a symbol)",
    ...byLine.get(line),
  }));

  writeFileSync(
    process.env.POLY_LENS_OUT,
    `${JSON.stringify({ vscode: vscode.version, lenses: lines }, null, 2)}\n`,
  );
  console.log(`ref-lens: ${lines.length} lines carry a lens`);
};
