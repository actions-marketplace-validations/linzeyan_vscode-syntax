// The list documents the keystrokes are performed on.
//
// `list.ts` says three times, in three different comments, that what Tab and
// Enter produce is what `poly fmt` normalizes to -- the column a child starts
// at, the marker the next item gets, the numbers of both lists an item moved
// between. Nothing checks it, and the two halves are in different languages:
// the rule is TypeScript in this repo, the formatter is dprint-plugin-markdown
// inside the Rust binary. A rule transcribed from another program's behaviour
// is the thing that was already wrong once this week.
//
// Sloppiness here is free: every document is formatted before a key is pressed,
// so the generator only has to produce something that *is* a list, not
// something already in the shape the formatter wants.
const SEED = Number(process.env.POLY_LIST_SEED ?? 20260920);
const ROUNDS = Number(process.env.POLY_LIST_ROUNDS ?? 300);

/** Deterministic PRNG. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["alpha", "beta", "gamma", "delta", "item", "note", "text", "one", "two"];

/**
 * Documents whose shape is named in a comment in `list.ts`, one each.
 *
 * A failure in this half names the rule it broke; the generated half only says
 * that something in this area is wrong.
 */
const STATED = [
  "- a\n- b\n",
  "1. a\n2. b\n",
  "1. a\n1. b\n1. c\n",
  "1) a\n2) b\n",
  "9. a\n10. b\n",
  "- a\n  - b\n  - c\n- d\n",
  "1. a\n   1. b\n   2. c\n2. d\n",
  "10. a\n    - b\n11. c\n",
  "- [ ] a\n- [x] b\n",
  "- a\n\n- b\n\n- c\n",
  "- a\n  wrapped\n- b\n",
  "> a\n> b\n",
  "> a\n>\n> b\n",
  "- a\n    - over indented\n- b\n",
  "1. a\n2. b\n3. c\n4. d\n",
  "* a\n* b\n",
  "+ a\n+ b\n",
  "para\n\n- a\n- b\n\npara\n",
  "1. a\n   - b\n     1. c\n",
  "- a\n\n  second paragraph\n\n- b\n",
];

/** One list, appended to `lines`, possibly with a child list under an item. */
function list(rand, lines, indent, depth) {
  const ordered = rand() < 0.5;
  // And only `.`, for the reason below: measured, `poly fmt` rewrites every `)`
  // to `.` as well, keeping one only where the change would merge two lists.
  const delimiter = ".";
  const flat = ordered && rand() < 0.3; // the all-`1.` style the formatter keeps
  // Only `-`. Measured: `poly fmt` rewrites every `*` and `+` to `-`, the one
  // exception being a `*` list directly after a `-` list, where changing it
  // would merge the two. So a formatted document -- which is the only kind a
  // keystroke ever lands on -- has no other bullet in it, and generating one
  // asks the formatter about its own normalization rather than about Tab.
  // `list.ts` still has to read `*`, `+` and `)`, because those are what people
  // type; the unit tests are where that is asked about.
  const bullet = "-";
  // A child list follows its parent's text with no blank line between, and an
  // ordered item may only interrupt a paragraph when it starts at 1: `   8. b`
  // under `1. a` is not a list at all, it is the second line of a's paragraph.
  // The generator kept producing those, and `list.ts` -- one regex per line,
  // like every list-continuation feature in every editor -- read them as items
  // and renumbered text nobody had written a number for. That is a real blind
  // spot and it is written down in 08; it is not the claim this file is here to
  // check, and left in it produced twelve failures that were all the same one.
  const start = depth > 0 || flat ? 1 : 1 + Math.floor(rand() * 10);
  const count = 1 + Math.floor(rand() * 3);
  const loose = rand() < 0.25;
  for (let i = 0; i < count; i++) {
    const marker = ordered ? `${flat ? 1 : start + i}${delimiter}` : bullet;
    const box = !ordered && rand() < 0.25 ? (rand() < 0.5 ? "[ ] " : "[x] ") : "";
    lines.push(`${indent}${marker} ${box}${WORDS[Math.floor(rand() * WORDS.length)]}`);
    const column = indent.length + marker.length + 1;
    if (rand() < 0.2) {
      lines.push(`${" ".repeat(column)}${WORDS[Math.floor(rand() * WORDS.length)]}`);
    }
    if (depth < 2 && rand() < 0.35) {
      list(rand, lines, " ".repeat(column), depth + 1);
    }
    if (loose && i < count - 1) {
      lines.push("");
    }
  }
}

/** A quoted block, which is the one place an empty marker line is content. */
function quote(rand, lines) {
  const count = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i++) {
    lines.push(`> ${WORDS[Math.floor(rand() * WORDS.length)]}`);
    if (rand() < 0.3) lines.push(">");
  }
}

function document(rand) {
  const lines = [];
  const blocks = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < blocks; i++) {
    const roll = rand();
    if (roll < 0.12) {
      lines.push(WORDS[Math.floor(rand() * WORDS.length)]);
    } else if (roll < 0.24) {
      quote(rand, lines);
    } else {
      list(rand, lines, "", 0);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function generated() {
  const rand = random(SEED);
  return Array.from({ length: ROUNDS }, () => document(rand));
}

exports.SEED = SEED;
exports.DOCUMENTS = [...STATED, ...generated()];
exports.random = random;
