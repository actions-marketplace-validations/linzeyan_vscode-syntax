#!/usr/bin/env node
// Do poly's heading anchors match the ones the editor writes?
//
// `markdown.ts` claims its slugifier is VSCode's, transcribed character for
// character from markdown-language-features. That claim is load-bearing: a
// table of contents whose links do not resolve in the renderer that wrote them
// is worse than no table of contents. Nothing checked it against the renderer
// -- the unit tests check it against examples, and examples are written by
// whoever wrote the rule.
//
// So: render each heading through `markdown.api.render`, which is the
// preview's own pipeline, and read the id off the tag.
//
// Usage: node tools/toc-fuzz/run.js [--seed N] [--rounds N]
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = resolve(__dirname, "..", "..");
const EDITOR = join(ROOT, "extensions", "editor");
const { runTests } = require(join(ROOT, "extensions", "lsp", "node_modules", "@vscode", "test-electron"));

const SCRATCH = join(tmpdir(), "poly-toc-fuzz");
const OUT = join(ROOT, ".logs", "audit", "toc-fuzz.json");
const CACHE = join(ROOT, "extensions", "lsp", ".vscode-test");
const MODULE = join(SCRATCH, "markdown.cjs");

const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};

/**
 * Headings whose anchor is known to differ, one line of reason each.
 *
 * Everything the editor resolves before it slugifies has to be resolved here
 * too, and these three are the ones where doing that means carrying a renderer
 * rather than a rule. Written down rather than dropped from the corpus: a
 * silent exclusion is how a corpus stops asking the question it was built for.
 */
const KNOWN = {
  "&amp; entity": "markdown-it decodes the whole HTML5 entity set, some two thousand names. "
    + "Carrying that table to anchor `## &amp;` correctly is not a trade worth making.",
  "&lt;not a tag&gt;": "Same: the entity is decoded before the heading text exists.",
  "math $x^2$": "markdown-math renders this with KaTeX, so the heading text is a typeset "
    + "formula and there is no anchor poly can compute without one.",
};

/**
 * Every code point the two slugifiers disagree about removing.
 *
 * The sampled headings can only ask about the characters somebody put in the
 * corpus, and the whole defect this found was characters nobody had thought
 * of. The editor ships its rule as one generated character class, so the class
 * can be lifted out of the bundle and both asked about all 1114112 code points
 * -- which turns "the table matches" from a claim into an enumeration.
 */
function classDisagreements(builtinBundle, polySource) {
  // Both rules are lifted out of the source that ships them, rather than one
  // being imported and the other transcribed: a transcription is the thing
  // that was wrong here in the first place.
  const lift = (file, marker) => {
    // The name and the literal are not reliably on one line, and not
    // reliably adjacent either: `poly fmt` puts a newline after the `=`, and
    // the lint suppression the copied class needs sits between the two. So:
    // find the name, then take the next line that is a whole regex literal.
    // Both narrower readings have been wrong here, and a rule read as the
    // empty string compares unequal to everything without saying so.
    const lines = readFileSync(file, "utf8").split("\n");
    // The marker carries its `=` so this lands on the assignment: a bundler
    // hoists the name into a `var a, b, c;` twelve lines above it, and the
    // first line merely mentioning the name has no rule on it at all.
    const at = lines.findIndex((one) => one.includes(marker));
    const literal = /^\s*(\/.+\/[a-z]*);?\s*$/;
    // The literal may sit on the marker's own line, as it does in the editor's
    // bundle, or a few lines below it, as it does after `poly fmt`. Take what
    // follows the `=` on the marker line and the whole of each line after.
    const found = at === -1 ? null : lines.slice(at, at + 6)
      .map((one, index) => literal.exec(index === 0 ? one.slice(one.indexOf("=") + 1) : one))
      .find(Boolean);
    if (!found) throw new Error(`no ${marker} in ${file}: that side's rule could not be read`);
    const body = found[1];
    const cut = body.lastIndexOf("/");
    // Each side's own flags, minus `g`. The editor's class is written for
    // non-unicode mode and matches astral characters through surrogate-pair
    // alternations, so adding `u` to it changes what it means -- done once by
    // mistake here, it reported 950008 disagreements. And `.test` on a sticky
    // or global regex carries `lastIndex` from call to call, which turns a
    // per-code-point loop into alternating answers.
    return new RegExp(body.slice(1, cut), body.slice(cut + 1).replace("g", ""));
  };
  const theirs = lift(builtinBundle, "githubSlugReplaceRegex =");
  const mine = lift(polySource, "const REMOVED =");

  // `lift` has read the wrong line twice already, and a regex that is merely
  // the wrong one still answers 1114112 questions without complaining. Both
  // sides have to behave like a slug removal rule before their answers mean
  // anything: punctuation goes, letters stay.
  for (const [name, rule] of [["vscode", theirs], ["poly", mine]]) {
    if (!rule.test("!") || rule.test("a")) {
      throw new Error(`${name}'s lifted rule is not a slug removal class: ${rule}`);
    }
  }

  const disagree = [];
  for (let point = 0; point <= 0x10ffff; point++) {
    // Surrogates are not characters on their own, and neither side is asked
    // about them by any text the editor will hand it.
    if (point >= 0xd800 && point <= 0xdfff) continue;
    const char = String.fromCodePoint(point);
    if (theirs.test(char) !== mine.test(char)) {
      disagree.push(point);
      if (disagree.length > 40) break;
    }
  }
  return disagree;
}

/**
 * The newest VSCode already downloaded, or none.
 *
 * `@vscode/test-electron` lays a build out the way its platform does: a
 * bundle on macOS, `resources/app` beside the binary everywhere else. Only
 * looking for the bundle made this return nothing on Linux, where the run then
 * fell through to a hard-coded `/Applications` path that cannot exist -- CI
 * tokenized all 448 headings and then failed reading the editor's own rule.
 */
function cachedBuild() {
  if (!existsSync(CACHE)) return null;
  const builds = readdirSync(CACHE)
    .map((name) => ({ name, version: /(\d+)\.(\d+)\.(\d+)$/.exec(name) }))
    .filter((build) => build.name.startsWith("vscode-") && build.version)
    .sort((a, b) =>
      Number(a.version[1]) - Number(b.version[1])
      || Number(a.version[2]) - Number(b.version[2])
      || Number(a.version[3]) - Number(b.version[3])
    );
  const build = builds.pop();
  if (!build) return null;
  const dir = join(CACHE, build.name);
  const macos = join(dir, "Visual Studio Code.app", "Contents", "MacOS");
  // The app directory is found by looking for it rather than by deriving it
  // from the executable, because the executable is the part whose name varies
  // -- `Electron`, `code`, `Code.exe` -- and it is the optional half here: it
  // only saves a download, while the app directory is what the comparison
  // cannot run without.
  const app = existsSync(macos)
    ? join(dir, "Visual Studio Code.app", "Contents", "Resources", "app")
    : join(dir, "resources", "app");
  if (!existsSync(app)) return null;
  const executable = existsSync(macos)
    ? join(macos, readdirSync(macos)[0])
    : [join(dir, "code"), join(dir, "Code.exe")].find((path) => existsSync(path));
  return { app, executable };
}

/** The app bundle the built-ins live in, said out loud when there is none. */
function appRoot() {
  const installed = "/Applications/Visual Studio Code.app/Contents/Resources/app";
  const found = cachedBuild()?.app ?? (existsSync(installed) ? installed : null);
  if (!found) {
    throw new Error(
      `no VSCode to read the slugifier out of: nothing usable under ${CACHE}. `
        + "Run `make e2e` first, or install VSCode.",
    );
  }
  return found;
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) delete process.env[key];
  }
  mkdirSync(join(SCRATCH, "workspace"), { recursive: true });
  mkdirSync(join(ROOT, ".logs", "audit"), { recursive: true });

  // The module under test, built on its own rather than taken out of the
  // bundle: `dist/extension.js` is minified and exports nothing, and the point
  // is to compare the source of truth rather than a copy of it.
  execFileSync(
    join(EDITOR, "node_modules", ".bin", "esbuild"),
    [
      join(EDITOR, "src", "markdown.ts"),
      "--bundle",
      `--outfile=${MODULE}`,
      "--format=cjs",
      "--platform=node",
    ],
    { stdio: "inherit" },
  );

  await runTests({
    extensionDevelopmentPath: EDITOR,
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: {
      POLY_TOC_OUT: OUT,
      POLY_TOC_MODULE: MODULE,
      POLY_TOC_SEED: String(flag("--seed", "20260920")),
      POLY_TOC_ROUNDS: String(flag("--rounds", "400")),
    },
    // Both, so a machine with nothing cached downloads into the same place the
    // end-to-end tests do rather than making a second copy beside the repo --
    // which is what CI did, and then looked for the first one.
    cachePath: CACHE,
    ...(cachedBuild()?.executable
      ? { vscodeExecutablePath: cachedBuild().executable }
      : {}),
    launchArgs: [
      `--folder-uri=${pathToFileURL(join(SCRATCH, "workspace")).toString()}`,
      `--user-data-dir=${join(SCRATCH, "user-data")}`,
      `--extensions-dir=${join(SCRATCH, "extensions")}`,
      "--disable-workspace-trust",
    ],
  });

  const report = JSON.parse(readFileSync(OUT, "utf8"));

  // Asked of every code point rather than of the corpus, because the corpus
  // only contains characters somebody thought of and the defect was the ones
  // nobody did.
  const bundle = join(
    appRoot(),
    "extensions",
    "markdown-language-features",
    "dist",
    "serverWorkerMain.js",
  );
  const disagree = classDisagreements(bundle, join(EDITOR, "src", "markdown.ts"));

  // The preview has to have written an id at all. Without one every case
  // compares null against a string and the whole run is one failure repeated,
  // or -- worse, if poly ever returned null -- agreement.
  if (!/\sid="hello-world"/.test(report.sample)) {
    throw new Error(
      `the preview did not write the expected id for a plain heading, so nothing here is comparable:\n${
        report.sample.slice(0, 300)
      }`,
    );
  }

  // A heading of nothing but whitespace is a category rather than a list: the
  // generated corpus produces tabs, ordinary spaces and non-breaking ones, and
  // enumerating them would be enumerating the alphabet. `headings` trims the
  // text and drops what is left empty, so the editor writes an empty id and
  // poly writes no entry -- which is the right list to be absent from.
  const why = (one) => (one.text.trim() === "" ? "a heading of nothing but whitespace" : KNOWN[one.text]);
  const all = report.cases.filter((one) => one.ours !== one.theirs);
  const differing = all.filter((one) => !why(one));
  const accepted = all.filter((one) => why(one));
  const sameDuplicates = JSON.stringify(report.duplicates.ours) === JSON.stringify(report.duplicates.theirs);

  console.log(`\nVSCode ${report.vscode}, ${report.cases.length} headings`);
  console.log(
    disagree.length === 0
      ? "  the two removal rules agree at every one of 1114112 code points"
      : `  !! the removal rules disagree at ${disagree.length}+ code points: ${
        disagree.slice(0, 10).map((point) => `U+${point.toString(16).toUpperCase()}`).join(", ")
      }`,
  );
  console.log(`  ${report.cases.length - all.length} anchors identical`);
  if (accepted.length > 0) {
    console.log(`\n${accepted.length} known to differ:`);
    for (const one of accepted) {
      console.log(`  ${JSON.stringify(one.text)} -- ${why(one)}`);
    }
  }
  if (differing.length > 0) {
    console.log(`\n${differing.length} differ:`);
    for (const one of differing.slice(0, 30)) {
      console.log(`  ${JSON.stringify(one.text)}`);
      console.log(`    vscode: ${JSON.stringify(one.theirs)}`);
      console.log(`    poly:   ${JSON.stringify(one.ours)}`);
    }
    if (differing.length > 30) console.log(`  ... and ${differing.length - 30} more`);
  }
  if (!sameDuplicates) {
    console.log("\nrepeated headings are numbered differently:");
    console.log(`  vscode: ${JSON.stringify(report.duplicates.theirs)}`);
    console.log(`  poly:   ${JSON.stringify(report.duplicates.ours)}`);
  }

  writeFileSync(OUT, `${JSON.stringify({ ...report, differing }, null, 2)}\n`);
  if (differing.length > 0 || !sameDuplicates || disagree.length > 0) {
    process.exit(1);
  }
  console.log("\nevery anchor poly writes is the one the editor writes");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
