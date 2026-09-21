// poly's heading anchors against the ones VSCode's own preview writes.
//
// `markdown.ts` says its slugifier is VSCode's "transcribed character for
// character", and the unit tests check that claim against examples written by
// the same hand as the rule -- which is how the reference lens came to count
// parameters. The editor will answer the question itself: render the heading
// and read the id off the tag.
//
// `markdown.api.render` is the preview's own pipeline, so the id here is the id
// a reader's anchor link has to match.
const { writeFileSync } = require("node:fs");

const vscode = require("vscode");

const { HEADINGS } = require("./cases.js");

const ID = /<h[1-6][^>]*\sid="([^"]*)"/g;

/** Every heading id the preview wrote, in document order. */
async function anchors(markdown) {
  // One untitled document per heading and none of them closed, which is why
  // this run prints "[LanguageService._onDidChange] potential listener LEAK
  // detected" and the same for ThemeService: VSCode registers listeners per
  // text model and warns past its own thresholds of 200 and 400. Measured
  // 2026-09-21 by opening 500 documents under an extension whose `activate` is
  // empty -- identical warnings, so they are the document count and not poly.
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
  const html = await vscode.commands.executeCommand("markdown.api.render", document);
  return [...String(html).matchAll(ID)].map((match) => match[1]);
}

/** The anchor poly's table of contents points at, for a one-heading document. */
function polyAnchor(toc, source) {
  const [line] = toc(source);
  // Anchored at the end of the line, because the label comes first and a
  // heading is free to contain the same punctuation a link is made of: a
  // generated heading of "(#x" produced the entry "- [(#x](#x)", where a
  // pattern matching inside the label reported poly as writing an anchor it
  // never wrote. The greedy prefix is the other half -- anchoring at the end
  // is not enough, because a match starting at the first "(#" can run to the
  // end of the line without meeting a ")".
  return line === undefined ? null : (/^.*\(#([^)]*)\)$/.exec(line)?.[1] ?? null);
}

exports.run = async function run() {
  const { slug, toc } = require(process.env.POLY_TOC_MODULE);

  const cases = [];
  for (const text of HEADINGS) {
    // One heading per document: ids are deduplicated within a document, and
    // that rule is asked about separately below.
    //
    // Through `toc` rather than `slug` directly, because that is the pipeline
    // a reader's link comes out of: `headings` parses the line first, and it
    // has rules of its own -- the closing run of # in `## Closed ###` belongs
    // to the syntax rather than to the text, and asking `slug` about the raw
    // line reported that as a disagreement with the editor when both in fact
    // agree.
    const source = `## ${text}\n`;
    const [theirs = null] = await anchors(source);
    cases.push({ text, theirs, ours: polyAnchor(toc, source) });
  }

  // The other half: repeats. The preview numbers the second occurrence of an
  // anchor, and poly numbers across the whole document including the H1 it
  // leaves out of the list -- a rule with no test but this one.
  const repeated = [
    "# Same",
    "## Same",
    "## Same",
    "### Same",
    "## Other",
    "## Same",
    "## other",
    "## OTHER",
  ].join("\n");
  const duplicates = {
    theirs: await anchors(`${repeated}\n`),
    // poly's list drops H1, so the H1's anchor is added back for comparison.
    ours: [slug("Same"), ...toc(repeated).map((line) => /\(#([^)]*)\)/.exec(line)?.[1] ?? "")],
  };

  // The first rendering, kept whole: if the preview ever stops writing ids the
  // comparison above turns into "null equals null" for every case.
  const sample = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: "## Hello, World!\n",
  });

  writeFileSync(
    process.env.POLY_TOC_OUT,
    `${
      JSON.stringify(
        {
          vscode: vscode.version,
          cases,
          duplicates,
          sample: String(await vscode.commands.executeCommand("markdown.api.render", sample)),
        },
        null,
        2,
      )
    }\n`,
  );
  console.log(`toc-fuzz: ${cases.length} headings rendered`);
};
