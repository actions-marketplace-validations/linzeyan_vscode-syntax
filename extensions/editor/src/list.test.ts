import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  Dialect,
  enterAction,
  indentTarget,
  listItem,
  outdentTarget,
  renumberedAfterMove,
  renumberedTail,
} from "./list";

const lines = (text: string) => text.split("\n");
const indent = (text: string, index: number) => indentTarget(lines(text), index);
const outdent = (text: string, index: number) => outdentTarget(lines(text), index);
/** `[line, marker]` pairs, which is all a renumbering is. */
const renumbers = (text: string, index: number) => renumberedTail(lines(text), index).map((r) => [r.line, r.text]);

/** `>` continues the list, `|` ends it -- the two shapes Enter can produce. */
const enter = (text: string, index: number, dialect: Dialect = "markdown", column?: number) => {
  const action = enterAction(lines(text), index, dialect, column);
  if (!action) {
    return undefined;
  }
  return `${action.kind === "continue" ? ">" : "|"}${action.text}`;
};

/** The same pairs, for the renumbering Tab and Shift+Tab set off. */
const moved = (text: string, index: number, indent: string) =>
  renumberedAfterMove(lines(text), index, indent).map((r) => [r.line, r.text]);

/** What else the same keystroke rewrites, as `[line, text]` pairs. */
const also = (text: string, index: number, column?: number) =>
  (enterAction(lines(text), index, "markdown", column)?.also ?? []).map((r) => [r.line, r.text]);

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
  // A bare marker with no space is still empty.
  assert.equal(enter("- a\n-", 1), "|");
});

test("a blank line inside a quote is content, so it takes two Enters to leave", () => {
  // `> a` / `>` / `> b` is one quote holding two paragraphs, which is why the
  // first Enter writes the blank quoted line instead of ending the block.
  assert.equal(enter("> a\n> ", 1), "|>\n> ");
  assert.equal(enter("> a\n>\n> ", 2), "|");
  // Nothing above it to quote: the marker was typed and thought better of.
  assert.equal(enter("> ", 0), "|");
  assert.equal(enter("prose\n> ", 1), "|");
});

test("leaving a quote takes the blank line it stepped through with it", () => {
  assert.deepEqual(also("> a\n>\n> ", 2), [[1, ""]]);
  // Nothing to clean up when the quote was never entered.
  assert.deepEqual(also("> ", 0), []);
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

test("inserting into an ordered list renumbers what comes after it", () => {
  // The case the differential found: poly wrote `3.` in front of an existing
  // `3.` and left both, which `poly fmt` then renumbered on the next save.
  assert.deepEqual(renumbers("1. a\n2. b\n3. c", 1), [[2, "4."]]);
  assert.deepEqual(renumbers("1. a\n2. b\n3. c\n4. d", 1), [[2, "4."], [3, "5."]]);
  assert.deepEqual(renumbers("1. a\n2. b", 1), []);
  // A loose list keeps counting across its own blank lines, and an item's
  // wrapped content and children are not siblings.
  assert.deepEqual(renumbers("1. a\n\n2. b\n\n3. c", 2), [[4, "4."]]);
  assert.deepEqual(renumbers("1. a\n   more\n2. b", 0), [[2, "3."]]);
  assert.deepEqual(renumbers("1. a\n   1. x\n2. b", 0), [[2, "3."]]);
});

test("renumbering stops where the list does", () => {
  // A paragraph, a shallower item, and a different delimiter each end it.
  assert.deepEqual(renumbers("1. a\n2. b\n\nprose\n\n5. c", 0), [[1, "3."]]);
  assert.deepEqual(renumbers("  1. a\n  2. b\n1. outer", 0), [[1, "3."]]);
  assert.deepEqual(renumbers("1. a\n2. b\n3) c", 0), [[1, "3."]]);
  // Bullets do not count, and neither does the all-`1.` style: in both cases
  // the marker Enter writes is the one already there.
  assert.deepEqual(renumbers("- a\n- b", 0), []);
  assert.deepEqual(renumbers("1. a\n1. b\n1. c", 1), []);
});

test("the content column survives a marker that got wider", () => {
  // `9.  item` puts its content at column 4 and so does `10. `. Copying the two
  // spaces would put the next item's content at 5, one column off the list it
  // is in -- and that column is where a child of the item would start.
  assert.equal(enter("9.  a", 0), ">10. ");
  assert.equal(enter("1.  a", 0), ">2.  ");
  assert.equal(enter("99.  a", 0), ">100. ");
  // Never below one space: `100.` is already wider than the column allows.
  assert.equal(enter("9. a", 0), ">10. ");
});

test("a checkbox goes with its words when Enter moves all of them", () => {
  // Enter in front of the text leaves an empty item behind, and an empty item
  // is not the thing that was finished.
  assert.equal(enter("- [x] item", 0, "markdown", 6), ">- [x] ");
  assert.deepEqual(also("- [x] item", 0, 6), [[0, "[ ]"]]);
  // Splitting within the text is different: both halves have words, the first
  // keeps the box it earned and the second is new work.
  assert.equal(enter("- [x] item", 0, "markdown", 8), ">- [ ] ");
  assert.deepEqual(also("- [x] item", 0, 8), []);
  // At the end of the line nothing moves down at all.
  assert.equal(enter("- [x] item", 0, "markdown", 10), ">- [ ] ");
  assert.deepEqual(also("- [x] item", 0, 10), []);
  // Splitting inside the box itself is not a box moving anywhere.
  assert.equal(enter("- [x] item", 0, "markdown", 3), ">- [ ] ");
  assert.deepEqual(also("- [x] item", 0, 3), []);
});

test("Tab renumbers both the list it left and the list it joined", () => {
  // The differential's case: `2. test` becomes the third item of the nested
  // list, and the item under it stops being that list's first.
  assert.deepEqual(
    moved("1. a\n   1. x\n   2. y\n2. b\n   1. z", 3, "   "),
    [[3, "3."], [4, "4."]],
  );
  // Nothing above it at the new level, so it starts the list it just made.
  assert.deepEqual(moved("1. a\n2. b", 1, "   "), [[1, "1."]]);
  // Outdenting splits the old list: the item joins the outer one, and what
  // followed it is now nested under it and starts over.
  assert.deepEqual(moved("1. a\n   1. x\n   3. y\n   4. z", 2, ""), [[2, "2."], [3, "1."]]);
  // A bullet belongs to no numbering on either side of the move.
  assert.deepEqual(moved("- a\n  - x\n- b", 2, "  "), []);
  // The all-`1.` style is a style, not a list that lost count.
  assert.deepEqual(moved("1. a\n   1. x\n   1. y\n2. b", 3, "   "), [[3, "1."]]);
});
