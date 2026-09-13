import * as assert from "node:assert/strict";
import { test } from "node:test";

import { Dialect, enterAction, indentTarget, listItem, outdentTarget } from "./list";

const lines = (text: string) => text.split("\n");
const indent = (text: string, index: number) => indentTarget(lines(text), index);
const outdent = (text: string, index: number) => outdentTarget(lines(text), index);

/** `>` continues the list, `|` ends it -- the two shapes Enter can produce. */
const enter = (text: string, index: number, dialect: Dialect = "markdown") => {
  const action = enterAction(lines(text), index, dialect);
  if (!action) {
    return undefined;
  }
  return `${action.kind === "continue" ? ">" : "|"}${action.text}`;
};

test("a marker needs whitespace or the end of the line after it", () => {
  assert.equal(listItem("- a")?.marker, "-");
  assert.equal(listItem("* a")?.marker, "*");
  assert.equal(listItem("+ a")?.marker, "+");
  assert.equal(listItem("1. a")?.marker, "1.");
  assert.equal(listItem("10) a")?.marker, "10)");
  assert.equal(listItem("- ")?.marker, "-");
  assert.equal(listItem("-")?.marker, "-");
  // A hyphen against a word is a paragraph, and a rule is not an item.
  assert.equal(listItem("-a"), undefined);
  assert.equal(listItem("prose"), undefined);
});

test("a child starts where its parent's content does, not at a tab stop", () => {
  assert.equal(indent("- a\n- b", 1), "  ");
  assert.equal(indent("1. a\n1. b", 1), "   ");
  assert.equal(indent("10. a\n10. b", 1), "    ");
  // Wide spacing is the author's, and their content column is the real one.
  assert.equal(indent("-   a\n- b", 1), "    ");
});

test("an item already as deep as it can go leaves Tab alone", () => {
  // Two spaces under `- ` is already the child level; four is the same level
  // written wider, which is why `poly fmt` pulls it back to two.
  assert.equal(indent("- a\n  - b", 1), undefined);
  assert.equal(indent("- a\n    - b", 1), undefined);
});

test("the level comes from the previous sibling, one step at a time", () => {
  // `c` moves under `b`, not under `a` and not two levels at once.
  assert.equal(indent("- a\n  - b\n  - c", 2), "    ");
  assert.equal(indent("- a\n  - b\n- c", 2), "  ");
});

test("the first item of a list has no level to move to", () => {
  assert.equal(indent("- a", 0), undefined);
  assert.equal(indent("prose\n- a", 1), undefined);
  assert.equal(indent("# heading\n\n- a", 2), undefined);
});

test("blank lines and wrapped content do not hide the sibling above", () => {
  assert.equal(indent("- a\n\n- b", 2), "  ");
  assert.equal(indent("- a\n  wrapped onto a second line\n- b", 2), "  ");
  assert.equal(indent("- a\n\n  a paragraph inside a\n\n- b", 4), "  ");
});

test("outdent lands on the enclosing item's own column", () => {
  assert.equal(outdent("- a\n  - b", 1), "");
  assert.equal(outdent("1. a\n   1. b\n      1. c", 2), "   ");
  // Nothing encloses it, so the left margin is where it belongs -- which is
  // what makes this the undo for an over-indented first item.
  assert.equal(outdent("  - orphan", 0), "");
});

test("outdent leaves a top-level item and a non-item alone", () => {
  assert.equal(outdent("- a\n- b", 1), undefined);
  assert.equal(outdent("prose", 0), undefined);
});

test("Tab does not treat a quote as a level", () => {
  assert.equal(indent("> a\n> b", 1), undefined);
  assert.equal(outdent("> a\n  > b", 1), undefined);
});

test("Enter repeats the marker and the indentation", () => {
  assert.equal(enter("- a", 0), ">- ");
  assert.equal(enter("* a", 0), ">* ");
  assert.equal(enter("+ a", 0), ">+ ");
  assert.equal(enter("- a\n  - b", 1), ">  - ");
  assert.equal(enter("> quoted", 0), ">> ");
  assert.equal(enter("prose", 0), undefined);
});

test("an ordered list counts up", () => {
  assert.equal(enter("1. a", 0), ">2. ");
  assert.equal(enter("1. a\n2. b", 1), ">3. ");
  assert.equal(enter("9. a\n10. b", 1), ">11. ");
  assert.equal(enter("1) a", 0), ">2) ");
  // Nesting numbers independently: the item above a nested first item is its
  // parent, not its sibling.
  assert.equal(enter("1. a\n   1. b", 1), ">   2. ");
});

test("a list written entirely as `1.` stays that way", () => {
  assert.equal(enter("1. a\n1. b", 1), ">1. ");
  assert.equal(enter("1. a\n1. b\n1. c", 2), ">1. ");
  // Two items that disagree are not that style, so the count resumes.
  assert.equal(enter("1. a\n2. b\n1. c", 2), ">2. ");
});

test("a task item continues unticked, whichever way this one went", () => {
  assert.equal(enter("- [ ] a", 0), ">- [ ] ");
  assert.equal(enter("- [x] a", 0), ">- [ ] ");
  assert.equal(enter("- [X] a", 0), ">- [ ] ");
  assert.equal(enter("1. [x] a", 0), ">2. [ ] ");
});

test("an empty item ends the list instead of breeding another", () => {
  assert.equal(enter("- a\n- ", 1), "|");
  assert.equal(enter("1. a\n2. ", 1), "|");
  assert.equal(enter("- a\n- [ ] ", 1), "|");
  assert.equal(enter("> a\n> ", 1), "|");
  // A bare marker with no space is still empty.
  assert.equal(enter("- a\n-", 1), "|");
});

test("an empty nested item steps out one level at a time", () => {
  assert.equal(enter("- a\n  - b\n  - ", 2), "|- ");
  assert.equal(enter("- a\n  - b\n    - c\n    - ", 3), "|  - ");
  assert.equal(enter("1. a\n   1. b\n   1. ", 2), "|1. ");
});

test("yaml continues a sequence and nothing else", () => {
  assert.equal(enter("items:\n  - a", 1, "yaml"), ">  - ");
  assert.equal(enter("items:\n  - a\n  - ", 2, "yaml"), "|");
  // `>` is a folded block scalar and `1.` is a string, so neither repeats.
  assert.equal(enter("key: >", 0, "yaml"), undefined);
  assert.equal(enter("1. not a list", 0, "yaml"), undefined);
  assert.equal(enter("key: value", 0, "yaml"), undefined);
  // No task boxes in yaml: the brackets are a flow sequence.
  assert.equal(enter("  - [ ] a", 0, "yaml"), ">  - ");
});
