#!/usr/bin/env node
// poly-editor's mermaid rendering against VSCode's own, on the same corpus.
//
// The reference is the built-in `mermaid-markdown-features` (1.135+), which is
// the upstream `bierner.markdown-mermaid` is also built from -- so this asks
// the question that matters for a document: does it draw the same thing before
// and after the editor is new enough for poly to stand down.
//
// Two launches of one extension host: the first with the built-in in charge,
// the second with `--disable-extension` so poly is. Neither is a gate; it
// compares poly against software this repo does not ship.
//
// Usage: node tools/mermaid-diff/run.js
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = resolve(__dirname, "..", "..");
const EDITOR = join(ROOT, "extensions", "editor");
const { runTests } = require(join(ROOT, "extensions", "lsp", "node_modules", "@vscode", "test-electron"));

const SCRATCH = join(tmpdir(), "poly-mermaid-diff");
const OUT = join(ROOT, ".logs", "audit", "mermaid-diff.json");

const BUILT_IN = "vscode.mermaid-markdown-features";
const CACHE = join(ROOT, "extensions", "lsp", ".vscode-test");

/**
 * The editors poly's own renderer is asked to draw on, beside the newest one.
 *
 * The reference comparison can only run where the built-in exists, which is
 * 1.135 and later -- and that is exactly the range where poly stands down. So
 * the parity it proves is about a renderer nobody runs. These two are the range
 * poly actually serves: the floor its `engines.vscode` claims, and the version
 * on this machine. What they answer is "does poly draw there what it draws on
 * the editor the comparison used".
 */
const SERVED = ["1.85.0", "1.120.0"];

/**
 * The newest VSCode already downloaded, because the built-in only exists in
 * 1.135 and later and there is no point downloading a second copy of one.
 *
 * Ordered by version number and not by name. The cache also holds the old
 * builds `SERVED` asks for, and a string sort puts `1.85.0` after `1.138.0`:
 * the reference run then launched an editor with no built-in renderer in it,
 * measured poly against poly, and reported that the two agreed.
 */
function cachedVSCode() {
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
  const macos = join(CACHE, build.name, "Visual Studio Code.app", "Contents", "MacOS");
  return existsSync(macos) ? join(macos, readdirSync(macos)[0]) : null;
}

async function measure(extraArgs, out, version) {
  await runTests({
    extensionDevelopmentPath: EDITOR,
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: { POLY_MERMAID_OUT: out, POLY_EDITOR_DIST: EDITOR },
    // A named version is downloaded; without one the newest cached build is
    // reused. `cachePath` keeps both out of a `.vscode-test/` beside the
    // sources, which is where the harness puts it by default.
    ...(version ? { version, cachePath: CACHE } : {}),
    ...(!version && cachedVSCode() ? { vscodeExecutablePath: cachedVSCode() } : {}),
    launchArgs: [
      `--folder-uri=${pathToFileURL(join(SCRATCH, "workspace")).toString()}`,
      `--user-data-dir=${join(SCRATCH, "user-data")}`,
      // Empty on purpose, and pointed away from the repo: nothing here needs a
      // marketplace extension, and without it the host writes its profile into
      // a `.vscode-test/` beside the sources. Built-ins live in the app bundle,
      // so the reference renderer is still there.
      `--extensions-dir=${join(SCRATCH, "extensions")}`,
      "--disable-workspace-trust",
      ...extraArgs,
    ],
  });
  return JSON.parse(readFileSync(out, "utf8"));
}

/**
 * Every field this compares, on every case, on both sides.
 *
 * A field that is missing everywhere compares equal to itself and reports no
 * difference: the snapshot script once ran before the sections existed, and the
 * whole markdown half of this differential passed while measuring nothing.
 */
function assertMeasured(report) {
  const fields = [
    "containers",
    "sources",
    "codeFences",
    "svgs",
    "shapes",
    "labels",
    "failed",
    "titles",
    "tooltip",
  ];
  for (const [name, one] of Object.entries(report.cases)) {
    const missing = fields.filter((field) => one[field] === undefined);
    if (missing.length > 0) {
      throw new Error(`${report.side}: case ${name} measured nothing for ${missing.join(", ")}`);
    }
  }
}

/**
 * Diagram cases that drew nothing on either side.
 *
 * A source neither renderer understands compares equal to itself, so a typo in
 * the corpus reads as agreement. Every case in the `diagram` group names a type
 * mermaid registers, so one of the two has to draw it; the ones that fail both
 * ways are the corpus's fault until proven otherwise.
 */
function unrendered(theirs, ours) {
  return Object.entries(ours.cases)
    .filter(([name, mine]) => mine.group === "diagram" && !mine.svgs && !theirs.cases[name]?.svgs)
    .map(([name]) => name);
}

/**
 * What the two sides disagree about for one case, field by field.
 *
 * Labelled rather than named, because this answers two questions with the same
 * arithmetic: poly against the built-in on one editor, and poly against itself
 * on two editors.
 */
function differences(theirs, ours, labels = ["built-in", "poly"]) {
  const rows = [];
  for (const [name, mine] of Object.entries(ours.cases)) {
    const other = theirs.cases[name];
    if (!other) continue;
    const diff = {};
    for (
      const field of [
        "containers",
        "sources",
        "codeFences",
        "svgs",
        "shapes",
        "labels",
        "failed",
        "titles",
        "tooltip",
      ]
    ) {
      const a = JSON.stringify(other[field]);
      const b = JSON.stringify(mine[field]);
      if (a !== b) diff[field] = { [labels[0]]: other[field], [labels[1]]: mine[field] };
    }
    // Geometry is compared with a tolerance: the same diagram drawn with two
    // themes differs by a few pixels of stroke and font metrics, and calling
    // that a difference would bury the ones that matter.
    for (const field of ["width", "height"]) {
      const a = other[field] ?? 0;
      const b = mine[field] ?? 0;
      const bigger = Math.max(a, b);
      if (bigger > 0 && Math.abs(a - b) / bigger > 0.15) {
        diff[field] = { [labels[0]]: a, [labels[1]]: b };
      }
    }
    if (Object.keys(diff).length > 0) {
      rows.push({ name, group: mine.group, diff });
    }
  }
  return rows;
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) delete process.env[key];
  }
  mkdirSync(join(SCRATCH, "workspace"), { recursive: true });
  mkdirSync(dirname(OUT), { recursive: true });

  execFileSync("pnpm", ["run", "build"], { cwd: EDITOR, stdio: "inherit" });

  const theirs = await measure([], join(SCRATCH, "built-in.json"));
  const ours = await measure(["--disable-extension", BUILT_IN], join(SCRATCH, "poly.json"));

  assertMeasured(theirs);
  assertMeasured(ours);
  // The reference has to be the reference. Every field can be measured, every
  // case can agree, and the whole comparison still mean nothing -- which is
  // what happened when the editor picked for it turned out to predate the
  // built-in, leaving poly to agree with itself.
  if (theirs.side !== "built-in") {
    throw new Error(
      `VSCode ${theirs.vscode} has no built-in mermaid renderer to compare against; it arrived in 1.135`,
    );
  }
  if (theirs.vscode !== ours.vscode) {
    throw new Error(`the two sides ran on ${theirs.vscode} and ${ours.vscode}, so nothing is held equal`);
  }
  const rows = differences(theirs, ours);

  console.log(`\nVSCode ${theirs.vscode}, ${Object.keys(ours.cases).length} cases`);
  for (const side of [theirs, ours]) {
    if (side.timedOut) console.log(`  !! ${side.side} timed out before the page settled`);
    if (side.pageErrors.length > 0) {
      console.log(`  !! ${side.side} page errors: ${side.pageErrors.slice(0, 3).join(" | ")}`);
    }
  }
  const blank = unrendered(theirs, ours);
  if (blank.length > 0) {
    console.log(`  !! neither side drew: ${blank.join(", ")}`);
  }
  // The hover probe answers nothing unless some case draws a node carrying a
  // tooltip, and a probe that measures nothing agrees with itself. Same shape
  // as `unrendered`, one layer up.
  const hoverable = Object.values(theirs.cases).filter((one) => one.titles > 0).length;
  if (hoverable === 0) {
    console.log("  !! no case drew a tooltip: the interaction probe measured nothing");
  }
  report(rows);

  // The second question, and the one the reference comparison cannot reach:
  // poly's renderer only runs below 1.135, and everything above was measured on
  // an editor where it stands down.
  const served = {};
  for (const version of SERVED) {
    console.log(`\npoly on ${version} against poly on ${theirs.vscode}:`);
    // An editor poly claims to support but cannot run on is the finding, not a
    // crash: the run keeps going and the failure is written down with the rest.
    try {
      const one = await measure(
        ["--disable-extension", BUILT_IN],
        join(SCRATCH, `poly-${version}.json`),
        version,
      );
      assertMeasured(one);
      if (one.pageErrors.length > 0) {
        console.log(`  !! page errors: ${one.pageErrors.slice(0, 3).join(" | ")}`);
      }
      one.differences = differences(ours, one, [theirs.vscode, one.vscode]);
      served[version] = one;
      report(one.differences);
    } catch (error) {
      served[version] = { failed: String(error.message ?? error) };
      console.log(`  !! poly could not be measured on ${version}: ${served[version].failed}`);
    }
  }

  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, served, differences: rows }, null, 2)}\n`);
  console.log(`\nfull report: ${OUT.replace(`${ROOT}/`, "")}`);
}

/** One comparison's result, in the shape a reader can scan. */
function report(rows) {
  if (rows.length === 0) {
    console.log("no differences");
    return;
  }
  console.log(`\n${rows.length} cases differ:`);
  for (const { name, group, diff } of rows) {
    console.log(`\n  ${group}/${name}`);
    for (const [field, sides] of Object.entries(diff)) {
      console.log(`    ${field}:`);
      for (const [label, value] of Object.entries(sides)) {
        console.log(`      ${label}: ${JSON.stringify(value)}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
