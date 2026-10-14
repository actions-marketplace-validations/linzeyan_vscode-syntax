// The markdown half: headings, counted by the links that point at them.
//
// The provider is the editor's own markdown server, which the host has offline.
// What no unit test can say is the shape that server really hands over -- a
// heading as a `String`, each level a child of the one above -- and that it
// answers a reference query at the heading with the links elsewhere in the
// workspace, a file nobody opened included.
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * A guide three levels deep, and notes that link into it.
 *
 * `### From source` is the heading the depth limit used to drop, and
 * `## Usage` is linked only from the file that is never opened.
 */
const FIXTURE = {
  "guide.md": `# Guide

## Install

### From source

## Usage

See [install](#install) and [building](#from-source).
`,
  "notes.md": `# Notes

Read [the usage](guide.md#usage) and [install](./guide.md#install).
`,
};

/**
 * Every lens the guide may carry, by the text of its line. Exhaustive.
 *
 * `# Guide` is linked from nowhere and carries nothing: `no refs` over a
 * heading is what most headings would say, so it is not drawn.
 */
const EXPECTED = {
  "# Guide": [],
  "## Install": ["2 refs"],
  "### From source": ["1 ref"],
  "## Usage": ["1 ref"],
};

/** Written before the host launches, so the server finds notes.md on its own. */
exports.writeFixture = function writeFixture(workspace) {
  for (const [name, body] of Object.entries(FIXTURE)) {
    writeFileSync(join(workspace, name), body);
  }
  return { POLY_MD_GUIDE: join(workspace, "guide.md") };
};

/** What the guide's lenses say. */
exports.observeMarkdown = async function observeMarkdown(lensesFor) {
  // Required here rather than at the top of the file: run.js loads this same
  // module in plain node, where `vscode` does not resolve.
  const vscode = require("vscode");
  const uri = vscode.Uri.file(process.env.POLY_MD_GUIDE);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const drawn = Object.values(EXPECTED).filter((titles) => titles.length > 0).length;
  return (await lensesFor(uri, drawn)).map((lens) => ({
    text: document.lineAt(lens.range.start.line).text.trim(),
    title: lens.command?.title ?? "(unresolved)",
  }));
};

/** What the markdown lenses said, and what is wrong with it. */
exports.checkMarkdown = function checkMarkdown(observed) {
  console.log("\nmarkdown headings, answered by the editor's markdown server:");
  for (const one of observed ?? []) {
    console.log(`  ${one.title.padEnd(8)} ${one.text}`);
  }
  const said = new Map();
  for (const one of observed ?? []) {
    said.set(one.text, [...(said.get(one.text) ?? []), one.title]);
  }
  const problems = [];
  for (const [text, want] of Object.entries(EXPECTED)) {
    const got = said.get(text) ?? [];
    if (got.join("; ") !== want.join("; ")) {
      problems.push(`guide.md: ${text} — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  for (const one of observed ?? []) {
    if (!Object.hasOwn(EXPECTED, one.text)) {
      problems.push(`guide.md: a lens on a line that is not a heading: ${one.text} says ${one.title}`);
    }
  }
  return problems;
};
