#!/usr/bin/env node
// Does `poly fmt` leave the list keystrokes alone?
//
// `list.ts` is built on one claim: a child starts at the column its parent's
// content starts at, the next ordered marker counts the way the formatter
// counts, and both lists an item is moved between are renumbered -- all so that
// the next `poly fmt` has nothing to change. The comments say it three times.
// Nothing checked it, and nothing could: the unit tests assert against strings
// written by whoever wrote the rule, while the formatter is dprint's markdown
// plugin inside the Rust binary.
//
// So ask the formatter. Format a generated document, press one key, format
// again, and see whether the second run touches anything. The property is
// exactly the design claim, and its counterexample is exactly the defect:
// a keystroke whose work the formatter undoes.
//
// Usage: node tools/list-fuzz/run.js [--seed N] [--rounds N]
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..", "..");
const EDITOR = join(ROOT, "extensions", "editor");
const SCRATCH = join(tmpdir(), "poly-list-fuzz");
const MODULE = join(SCRATCH, "list.cjs");
const POLY = process.env.POLY_BIN ?? join(ROOT, "cli", "target", "release", "poly");

// The character the author types after pressing Enter. Without it the cursor's
// line is a marker followed by the space the next word goes in -- trailing
// whitespace, which the formatter strips and which no author ever leaves
// behind. Stripping it is the formatter being right, so the comparison would
// be measuring the wrong thing on every single case.
const CURSOR = "\u0000";

const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
if (flag("--seed") !== undefined) process.env.POLY_LIST_SEED = flag("--seed");
if (flag("--rounds") !== undefined) process.env.POLY_LIST_ROUNDS = flag("--rounds");

const { DOCUMENTS, SEED, random } = require("./cases.js");

/** Every span applied to one snapshot, right to left so the columns hold. */
function applyRewrites(lines, rewrites) {
  const out = lines.slice();
  const byLine = new Map();
  for (const rewrite of rewrites) {
    byLine.set(rewrite.line, [...(byLine.get(rewrite.line) ?? []), rewrite]);
  }
  for (const [line, spans] of byLine) {
    for (const span of [...spans].sort((a, b) => b.start - a.start)) {
      out[line] = out[line].slice(0, span.start) + span.text + out[line].slice(span.end);
    }
  }
  return out;
}

/**
 * One keystroke on line `index`, composed the way `extension.ts` composes it.
 *
 * Every rewrite is computed against the one snapshot and applied against it
 * too, because that is what a single `editor.edit()` does -- computing them
 * against the document the insertion produced would be a different program.
 */
function perform(list, lines, index, kind) {
  if (kind === "enter") {
    const action = list.enterAction(lines, index, "markdown", lines[index].length);
    if (!action) return undefined;
    // Ending a list replaces the item with nothing, so the author is left on a
    // blank line with a paragraph to type. A formatter run at that instant
    // takes the blank line back, and it is right to: the document is not
    // finished, and what the keystroke produced was the absence of an item.
    if (action.kind === "replace" && action.text === "") return undefined;
    const rewrites = action.kind === "continue"
      ? [...action.also, ...list.renumberedTail(lines, index, "markdown")]
      : action.also;
    const out = applyRewrites(lines, rewrites);
    if (action.kind === "continue") out.splice(index + 1, 0, action.text + CURSOR);
    else out[index] = action.text + CURSOR;
    return { kind, index, lines: out.join("\n").split("\n") };
  }
  const item = list.listItem(lines[index]);
  const target = (kind === "indent" ? list.indentTarget : list.outdentTarget)(lines, index);
  if (!item || target === undefined) return undefined;
  return {
    kind,
    index,
    lines: applyRewrites(lines, [
      ...list.renumberedAfterMove(lines, index, target),
      ...list.movedWith(lines, index, target),
      { line: index, start: 0, end: item.indent.length, text: target },
    ]),
  };
}

/** The first keystroke that applies somewhere in the document, or none. */
function gesture(list, pick, text) {
  const lines = text.split("\n");
  const candidates = lines
    .map((_, index) => index)
    .filter((index) => list.listItem(lines[index]) !== undefined);
  if (candidates.length === 0) return undefined;
  // Rotated rather than scanned from the top: the first list item in a document
  // is the one with no sibling above it, and starting there every time would
  // ask about one branch of `nextMarker` and never the other.
  const line = Math.floor(pick() * candidates.length);
  const kinds = ["enter", "indent", "outdent"];
  const first = Math.floor(pick() * kinds.length);
  for (let i = 0; i < candidates.length; i++) {
    for (let k = 0; k < kinds.length; k++) {
      const done = perform(
        list,
        lines,
        candidates[(line + i) % candidates.length],
        kinds[(first + k) % kinds.length],
      );
      if (done) return done;
    }
  }
  return undefined;
}

/** Write each text as its own file, format the directory, read them back. */
function formatted(name, texts) {
  const dir = join(SCRATCH, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = texts.map((text, index) => {
    const file = join(dir, `case-${String(index).padStart(4, "0")}.md`);
    writeFileSync(file, text.replaceAll(CURSOR, "x"));
    return file;
  });
  // One invocation for the whole directory: the binary starts once whether it
  // is handed one file or four hundred.
  execFileSync(POLY, ["fmt", dir], { stdio: "pipe" });
  return files.map((file) => readFileSync(file, "utf8"));
}

function main() {
  if (!existsSync(POLY)) {
    throw new Error(`no poly at ${POLY}: build it, or set POLY_BIN`);
  }
  mkdirSync(SCRATCH, { recursive: true });
  execFileSync(
    join(EDITOR, "node_modules", ".bin", "esbuild"),
    [
      join(EDITOR, "src", "list.ts"),
      "--bundle",
      `--outfile=${MODULE}`,
      "--format=cjs",
      "--platform=node",
    ],
    { stdio: "inherit" },
  );
  const list = require(MODULE);

  // The premise, checked rather than assumed: the keystroke is pressed on an
  // already-formatted document, so if formatting were not a fixed point every
  // case would fail and the report would blame the wrong module.
  //
  // The first run of this file is what found the one document where it was
  // not. `1. a` / `   10. b` / `       - c` is a single paragraph -- `10.`
  // cannot interrupt one, and the third line's indentation puts it four columns
  // past the item's content, where nothing starts a block either -- and
  // dprint-plugin-markdown 0.22 rewrote that third line at the content column,
  // where `-` *can* interrupt, so a bullet list appeared that the author never
  // typed. 4 of 320 generated documents, and a changed document rather than a
  // changed layout. The fix is upstream's, taken by moving the crate to 0.24,
  // so the second pass below is the check it was meant to be and not a
  // tolerance for a formatter that needed one more run.
  const once = formatted("normalize-1", DOCUMENTS);
  const normalized = formatted("normalize-2", once);
  const unstable = once.filter((text, index) => text !== normalized[index]);
  if (unstable.length > 0) {
    throw new Error(
      `poly fmt moved ${unstable.length} of ${once.length} documents on a second pass, `
        + `so nothing below is about list.ts:\n${JSON.stringify(unstable[0])}`,
    );
  }

  const pick = random(SEED ^ 0x5eed);
  const pressed = normalized.map((text) => ({ text, done: gesture(list, pick, text) }));
  const usable = pressed.filter((one) => one.done);
  const after = formatted("after", usable.map((one) => one.done.lines.join("\n")));

  const counts = new Map();
  for (const one of usable) counts.set(one.done.kind, (counts.get(one.done.kind) ?? 0) + 1);
  // Blank lines are not part of the claim. A keystroke that outdents a bullet
  // out of an ordered list really does split that list in three, and the
  // formatter really does put blank lines between three adjacent lists -- both
  // are right, and `list.ts` writes no blank line anywhere except on the way
  // out of a quote. What it does claim is the structure: which column each item
  // sits at and what marker it carries. So that is what is compared.
  const structure = (text) => text.split("\n").filter((line) => line.trim() !== "").join("\n");
  const differing = usable
    .map((one, index) => ({ ...one, formatted: after[index] }))
    .filter((one) => structure(one.done.lines.join("\n").replaceAll(CURSOR, "x")) !== structure(one.formatted));

  console.log(`\n${usable.length} of ${DOCUMENTS.length} documents took a keystroke`);
  console.log(
    `  ${[...counts].sort().map(([kind, count]) => `${kind} ${count}`).join(", ")}`,
  );
  // A keystroke that never applies proves nothing, and the three gestures fail
  // to apply for entirely different reasons -- so all three have to have run.
  for (const kind of ["enter", "indent", "outdent"]) {
    if ((counts.get(kind) ?? 0) === 0) {
      throw new Error(`no document took a ${kind}: the corpus asks nothing about it`);
    }
  }
  if (usable.length < DOCUMENTS.length / 2) {
    throw new Error(`only ${usable.length} documents took a keystroke: the corpus is mostly empty`);
  }

  if (differing.length > 0) {
    console.log(`\n${differing.length} keystrokes the formatter undid:`);
    for (const one of differing.slice(0, 8)) {
      const wrote = one.done.lines.join("\n").replaceAll(CURSOR, "x");
      console.log(`\n  ${one.done.kind} on line ${one.done.index} of:`);
      console.log(one.text.trimEnd().split("\n").map((line) => `    | ${line}`).join("\n"));
      console.log("  poly wrote:");
      console.log(wrote.trimEnd().split("\n").map((line) => `    | ${line}`).join("\n"));
      console.log("  poly fmt made it:");
      console.log(one.formatted.trimEnd().split("\n").map((line) => `    | ${line}`).join("\n"));
    }
    if (differing.length > 8) console.log(`\n  ... and ${differing.length - 8} more`);
    process.exit(1);
  }
  console.log("\nthe formatter changed nothing the keystrokes wrote");
}

try {
  main();
} catch (error) {
  console.error(error.message ?? error);
  process.exit(1);
}
