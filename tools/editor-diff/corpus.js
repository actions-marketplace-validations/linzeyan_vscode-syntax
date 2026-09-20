// markdown-all-in-one's own test cases, read out of its repository.
//
// The table in cases.js is what this repo thought to ask. This is what the
// maintainers of the thing poly replaced thought to ask, which is a different
// and better-aimed list: each one was written because somebody reported it.
//
// Taken from the default branch rather than a pinned sha, for the same reason
// run.js installs the marketplace's latest rather than a pinned version -- the
// question is whether poly still answers like the extension people actually
// have, and their tests describe what that extension does now.
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO = "yzhang-gh/vscode-markdown";
const FILES = [
  "blockquoteEditing",
  "formatting",
  "listEditing",
  "listEditing.fallback",
  "listRenumbering",
];

/** Their command -> poly's. Anything not here has no poly counterpart. */
const COMMANDS = {
  "markdown.extension.onEnterKey": "poly.continueList",
  "markdown.extension.onTabKey": "poly.indentListItem",
  "markdown.extension.onShiftTabKey": "poly.outdentListItem",
  "markdown.extension.editing.toggleBold": "poly.toggleBold",
  "markdown.extension.editing.toggleItalic": "poly.toggleItalic",
};

/**
 * Cases poly answers differently on purpose, keyed by their test name.
 *
 * Checked in both directions like the rest of the table: one of these that
 * stops differing means poly gave up the behaviour it was written to have.
 */
const EXPECTED = {
  "Toggle italic. Use `*`": "poly writes `_`, which is what `poly fmt` keeps; the original writes `*` (08 §9)",
  "Toggle bold. `**text|**` -> `**text**|`":
    "the original moves the caret out of the emphasis instead of toggling; poly's Ctrl+B on bold text unbolds it, which is what every other toggle in the editor does",
  // All five of these are a first item with nothing above it to nest under,
  // which poly leaves to the editor's own Tab; see
  // `tab/first-item-has-nothing-to-nest-under` in cases.js. The renumbering is
  // a second difference on top: `poly fmt` keeps a list that starts at 2
  // (measured), so poly has no reason to rewrite `2.` as `1.`.
  "Tab key. 1: '- |'": "poly declines to indent a first item; the original makes it an indented code block",
  "Tab key. 2: '-  |'": "poly declines to indent a first item; the original makes it an indented code block",
  "Tab key. 3: '- [ ] |'": "poly declines to indent a first item; the original makes it an indented code block",
  "Tab key. Fix ordered marker. 1":
    "poly declines to indent a first item, and `poly fmt` keeps a list that starts at 2",
  "Tab key. Fix ordered marker. 2":
    "poly declines to indent a first item, and `poly fmt` keeps a list that starts at 2",
  "Tab key. Fix ordered marker. 5: Selection range":
    "poly's list commands act on the item the cursor is in; a multi-line selection is the editor's own block indent, which its `when` clause promises to leave alone",
};

/** Split an argument list at top-level commas. */
function splitArgs(src) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The string literals of an array literal, in order. */
function arrayOfStrings(literal) {
  const out = [];
  let quote = null;
  let cur = "";
  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i];
    if (quote) {
      if (ch === quote && literal[i - 1] !== "\\") {
        out.push(cur);
        cur = "";
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") quote = ch;
  }
  return out.map((s) => s.replace(/\\(['"\\])/g, "$1"));
}

function fetchSources(scratch) {
  mkdirSync(scratch, { recursive: true });
  const sources = [];
  for (const name of FILES) {
    const path = join(scratch, `${name}.ts`);
    if (!existsSync(path)) {
      const url = `https://raw.githubusercontent.com/${REPO}/master/src/test/suite/integration/${name}.test.ts`;
      execFileSync("curl", ["-sSL", "-A", "poly-editor-diff", "-o", path, url]);
    }
    sources.push([name, readFileSync(path, "utf8")]);
  }
  return sources;
}

/**
 * Their `testCommand(command, before, selection, after, selection)` calls, as
 * cases this differential can run. Their expected output is deliberately not
 * read: it is what the extension does, and the point here is to ask both sides
 * and compare, not to assert one of them against a copy of its own answer.
 */
function corpusCases(scratch) {
  const cases = [];
  for (const [file, src] of fetchSources(scratch)) {
    const re = /test\(\s*(["'])((?:[^\\]|\\.)*?)\1[\s\S]*?testCommand\(/g;
    let m;
    while ((m = re.exec(src))) {
      const title = m[2];
      let depth = 1;
      let i = re.lastIndex;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
      }
      const args = splitArgs(src.slice(re.lastIndex, i - 1));
      if (args.length < 5) continue;
      const command = args[0].replace(/['"]/g, "");
      if (!COMMANDS[command]) continue;
      // Everything from the title to the end of the call, because both things
      // worth rejecting live outside the argument list. A `updateConfiguration`
      // before it means the test is about a setting this differential does not
      // set, so its answer would not be comparable; a second `test(` inside it
      // means the match ran past a test that calls no `testCommand` at all and
      // has borrowed the next one's.
      const body = src.slice(m.index, i);
      if (/updateConfiguration|getConfiguration/.test(body)) continue;
      if (/\btest\(/.test(body.slice("test(".length))) continue;
      const sel = /new Selection\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(args[2]);
      if (!sel) continue;
      const lines = arrayOfStrings(args[1]);
      cases.push({
        id: `maio/${file}/${title.replace(/\s+/g, "-").replace(/[^\w/.'|*-]/g, "")}`,
        upstream: title,
        language: "markdown",
        text: `${lines.join("\n")}\n`,
        marks: {
          anchor: { line: Number(sel[1]), character: Number(sel[2]) },
          active: { line: Number(sel[3]), character: Number(sel[4]) },
        },
        original: command,
        poly: COMMANDS[command],
        expect: EXPECTED[title] ?? "same",
      });
    }
  }
  return cases;
}

/**
 * Written next to the suite, because the host has no network of its own.
 *
 * A declared difference is keyed by the upstream test's name, and a name that
 * matches nothing is a declaration that does nothing -- it reads as "we know
 * about this" while the case it was written for goes on failing under some
 * other spelling. Two of them started out that way, which is why this throws.
 */
function writeCorpus(scratch, out) {
  const cases = corpusCases(scratch);
  const missing = Object.keys(EXPECTED).filter(
    (title) => !cases.some((one) => one.upstream === title),
  );
  if (missing.length > 0) {
    throw new Error(`no upstream test is named: ${missing.map((t) => `"${t}"`).join(", ")}`);
  }
  writeFileSync(out, JSON.stringify(cases, null, 2));
  return cases.length;
}

module.exports = { corpusCases, writeCorpus, EXPECTED };
