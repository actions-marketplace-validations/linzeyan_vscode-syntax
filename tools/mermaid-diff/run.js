#!/usr/bin/env node
// poly's mermaid rendering against VSCode's own, on the same corpus.
//
// The reference is the built-in `mermaid-markdown-features` (1.135+), which is
// the upstream `bierner.markdown-mermaid` is also built from -- so this asks
// the question that matters for a document: does it draw the same thing before
// and after the editor is new enough for poly to stand down.
//
// Two launches of one extension host: the first with the built-in in charge,
// the second with `--disable-extension` so poly is. Each walks the editor
// through four themes, because neither renderer is handed a palette -- both
// derive one from the variables the theme puts on the page. Neither is a gate;
// it compares poly against software this repo does not ship.
//
// Usage: node tools/mermaid-diff/run.js
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
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
 * The themes both renderers are asked to draw in.
 *
 * Neither of them is handed a palette: each derives mermaid's colours from the
 * `--vscode-*` variables the editor puts on the page, through its own table of
 * fallbacks. A table can agree in one theme and disagree in another -- a
 * variable a dark theme defines need not exist in a light one -- so a
 * difference here is invisible until the theme moves.
 *
 * The first one is the primary: it is what the cross-version runs use, because
 * what those ask is whether an older editor draws the same picture, and the
 * colour derivation does not depend on the editor's version.
 */
const THEMES = [
  "Default Dark Modern",
  "Default Light Modern",
  "Default High Contrast",
  "Default High Contrast Light",
];

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

async function measure(extraArgs, out, version, themes = [THEMES[0]]) {
  await runTests({
    extensionDevelopmentPath: LSP,
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: {
      POLY_MERMAID_OUT: out,
      POLY_EXTENSION_ROOT: LSP,
      // One launch per side rather than one per theme: booting an extension
      // host costs more than every diagram on the page put together.
      POLY_MERMAID_THEMES: themes.join(","),
    },
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

/** One theme's measurement, in the shape the comparisons take. */
function view(report, theme) {
  const one = report.themes[theme];
  if (!one) {
    throw new Error(`${report.side}: theme ${theme} was never measured`);
  }
  return { side: report.side, vscode: report.vscode, theme, ...one };
}

/**
 * That the editor really was in a different theme for each measurement.
 *
 * Both renderers read the body class to tell light from dark, so the page does
 * not set it -- which leaves the `workbench.colorTheme` write as the only thing
 * moving it. If that write does not take, four identical measurements compare
 * equal and the report claims parity across four themes it never entered.
 */
function assertThemesDiffered(report) {
  const seen = new Map();
  for (const [theme, one] of Object.entries(report.themes)) {
    if (!one.bodyClass) {
      throw new Error(`${report.side}: the page carried no theme class in ${theme}`);
    }
    if (Object.keys(one.vars).length === 0) {
      throw new Error(`${report.side}: no --vscode-* variables were readable in ${theme}`);
    }
    const twin = seen.get(one.bodyClass);
    if (twin) {
      throw new Error(
        `${report.side}: ${theme} and ${twin} both drew under "${one.bodyClass}", so one of them never applied`,
      );
    }
    seen.set(one.bodyClass, theme);
  }
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
    "palette",
  ];
  for (const [name, one] of Object.entries(report.cases)) {
    const missing = fields.filter((field) => one[field] === undefined);
    if (missing.length > 0) {
      throw new Error(`${report.side}: case ${name} measured nothing for ${missing.join(", ")}`);
    }
  }
}

/**
 * What the two editors offered a renderer, where they differ.
 *
 * A palette difference has two possible authors: the renderer picked a
 * different entry out of its fallback chain, or the editor handed it different
 * paint. Only the second is visible here, and it is the one that makes a
 * difference nobody has to fix -- an old editor whose theme is genuinely a
 * different colour is not poly drawing it wrong.
 */
function themeVars(left, right) {
  const names = new Set([...Object.keys(left.vars), ...Object.keys(right.vars)]);
  const gone = [...names].filter((name) => !(name in right.vars));
  const moved = [...names].filter((name) =>
    name in left.vars && name in right.vars && left.vars[name] !== right.vars[name]
  );
  return { gone, moved };
}

/**
 * What the race between two renders left on the page.
 *
 * Not a comparison: the built-in has its own answer to the same problem, and
 * this is about poly's. It is reported here because the property is only
 * visible with the real bundle in a real webview, which is what this harness
 * already builds.
 */
function staleRender(one) {
  const stale = one.stale;
  if (!stale) {
    return ["the stale-render probe did not run"];
  }
  const problems = [];
  // A probe that arrives too late measures a render that had already finished,
  // and a counter that was never raced cannot be caught dropping the wrong one.
  if (!stale.raced) {
    problems.push("the first render finished before the second began: nothing raced");
  }
  if (stale.svgs !== 1) {
    problems.push(`${stale.svgs} diagrams on a page that asked for one`);
  }
  if (stale.labels.includes("STALE")) {
    problems.push("the abandoned render landed and the newer one had nothing left to replace");
  }
  if (!stale.labels.includes("LATEST")) {
    problems.push(`the last content did not draw: ${stale.labels.slice(0, 3).join(", ")}`);
  }
  return problems;
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
        "palette",
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

  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });

  const theirs = await measure([], join(SCRATCH, "built-in.json"), null, THEMES);
  const ours = await measure(["--disable-extension", BUILT_IN], join(SCRATCH, "poly.json"), null, THEMES);

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
  assertThemesDiffered(theirs);
  assertThemesDiffered(ours);

  const byTheme = {};
  for (const theme of THEMES) {
    const left = view(theirs, theme);
    const right = view(ours, theme);
    assertMeasured(left);
    assertMeasured(right);
    if (left.bodyClass !== right.bodyClass) {
      throw new Error(
        `${theme} drew under "${left.bodyClass}" for the built-in and "${right.bodyClass}" for poly`,
      );
    }
    byTheme[theme] = differences(left, right);

    console.log(
      `\nVSCode ${theirs.vscode}, ${theme} (${left.bodyClass}), ${Object.keys(right.cases).length} cases`,
    );
    for (const side of [left, right]) {
      if (side.timedOut) console.log(`  !! ${side.side} timed out before the page settled`);
      if (side.pageErrors.length > 0) {
        console.log(`  !! ${side.side} page errors: ${side.pageErrors.slice(0, 3).join(" | ")}`);
      }
    }
    const blank = unrendered(left, right);
    if (blank.length > 0) {
      console.log(`  !! neither side drew: ${blank.join(", ")}`);
    }
    // The hover probe answers nothing unless some case draws a node carrying a
    // tooltip, and a probe that measures nothing agrees with itself. Same shape
    // as `unrendered`, one layer up.
    const hoverable = Object.values(left.cases).filter((one) => one.titles > 0).length;
    if (hoverable === 0) {
      console.log("  !! no case drew a tooltip: the interaction probe measured nothing");
    }
    report(byTheme[theme]);

    const racing = staleRender(right);
    console.log(
      racing.length === 0
        ? "  a render overtaken by the next one leaves only the newer drawing"
        : `  !! stale render: ${racing.join("; ")}`,
    );
  }

  // The second question, and the one the reference comparison cannot reach:
  // poly's renderer only runs below 1.135, and everything above was measured on
  // an editor where it stands down.
  const served = {};
  const primary = view(ours, THEMES[0]);
  for (const version of SERVED) {
    console.log(`\npoly on ${version} against poly on ${theirs.vscode}, ${THEMES[0]}:`);
    // An editor poly claims to support but cannot run on is the finding, not a
    // crash: the run keeps going and the failure is written down with the rest.
    try {
      const measured = await measure(
        ["--disable-extension", BUILT_IN],
        join(SCRATCH, `poly-${version}.json`),
        version,
      );
      const one = view(measured, THEMES[0]);
      assertMeasured(one);
      if (one.bodyClass !== primary.bodyClass) {
        throw new Error(
          `${version} drew under "${one.bodyClass}" and ${theirs.vscode} under "${primary.bodyClass}"`,
        );
      }
      one.differences = differences(primary, one, [theirs.vscode, one.vscode]);
      one.varsDiff = themeVars(primary, one);
      served[version] = one;
      // Colour is reported apart from the rest here, and only here. An older
      // editor's theme is a different theme: it defines fewer variables and
      // gives some of the ones it has another value, so a palette that follows
      // it is the derivation working rather than failing. What has to hold
      // across versions is the drawing -- same shapes, same labels, same size.
      const colourOnly = one.differences.filter((row) => Object.keys(row.diff).join() === "palette");
      const { gone, moved } = one.varsDiff;
      console.log(
        `  ${version} defines ${gone.length} fewer colour variables than ${theirs.vscode} `
          + `and gives ${moved.length} of the shared ones another value`,
      );
      if (one.pageErrors.length > 0) {
        console.log(`  !! page errors: ${one.pageErrors.slice(0, 3).join(" | ")}`);
      }
      if (colourOnly.length > 0) {
        console.log(`  ${colourOnly.length} cases differ in colour alone, which follows from that`);
      }
      report(one.differences.filter((row) => !colourOnly.includes(row)));
    } catch (error) {
      served[version] = { failed: String(error.message ?? error) };
      console.log(`  !! poly could not be measured on ${version}: ${served[version].failed}`);
    }
  }

  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, served, differences: byTheme }, null, 2)}\n`);
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
