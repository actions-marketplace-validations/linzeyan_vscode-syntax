/**
 * What Tab, Shift+Tab and Enter do to a list item.
 *
 * Tab is the gesture VSCode has no list-aware answer for: it indents by
 * `editor.tabSize`, and a list level is not a tab stop. A child starts at the
 * column its parent's content starts at -- 2 for `- `, 3 for `1. `, 4 for
 * `10. ` -- which is what `poly fmt` normalizes to (measured: a four-space
 * child of `1. ` comes back as three). Taking the width from the parent rather
 * than from a setting is what keeps Tab and the formatter from rewriting each
 * other's work, the same reason the emphasis toggles produce `**` and `_`.
 *
 * Enter is here for the two things a language-configuration `onEnterRules`
 * cannot express: an ordered marker that counts, and an empty item that ends
 * the list instead of breeding another one. Those rules can only append a
 * fixed string.
 */

/**
 * yaml gets its own marker set rather than a flag on the markdown one. `>` is
 * a folded block scalar there and `1.` is the string "1.", so continuing
 * either the way markdown does would corrupt the document -- the difference is
 * not a special case, it is a different language.
 */
export type Dialect = "markdown" | "yaml";

export interface ListItem {
  /** Leading whitespace, verbatim. */
  indent: string;
  /** `-`, `*`, `+`, `1.`, `10)`, and in markdown `>`. */
  marker: string;
  /** Whitespace between the marker and the content. */
  spacing: string;
  /** Everything after the marker, task checkbox included. */
  content: string;
  /** The column the item's content starts at, and so where a child begins. */
  contentColumn: number;
}

/**
 * A marker has to be followed by whitespace or end the line: `-foo` is a
 * paragraph starting with a hyphen, not a list. Nine digits is CommonMark's
 * own limit on an ordered marker.
 */
const ITEM: Record<Dialect, RegExp> = {
  markdown: /^([ \t]*)([-*+]|\d{1,9}[.)]|>)([ \t]+(?=\S)|[ \t]*$)(.*)$/,
  yaml: /^([ \t]*)(-)([ \t]+(?=\S)|[ \t]*$)(.*)$/,
};

const TASK = /^(\[[ xX]\])(?:[ \t]+(?=\S)|[ \t]*$)(.*)$/;
const ORDERED = /^(\d{1,9})([.)])$/;

export function listItem(
  line: string,
  dialect: Dialect = "markdown",
): ListItem | undefined {
  const match = ITEM[dialect].exec(line);
  if (!match) {
    return undefined;
  }
  const [, indent, marker, spacing, content] = match;
  return {
    indent,
    marker,
    spacing,
    content,
    // A bare `-` has no spacing to measure, but its child still belongs where
    // `- ` would have put it: the formatter writes the space back.
    contentColumn: indent.length + marker.length + Math.max(1, spacing.length),
  };
}

/**
 * The line above `index` that decides what `index` is part of, or -1.
 *
 * Scanning up skips blank lines (a loose list has them between items) and any
 * line indented past `atMost` -- those are somebody else's wrapped content, not
 * a sibling. The first line at or left of that column is the answer whether or
 * not it is a list item: a paragraph there ends the search, because the item is
 * the first of its list and a first item has no level to move to.
 */
function anchorIndex(
  lines: readonly string[],
  index: number,
  atMost: number,
): number {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") {
      continue;
    }
    if (/^[ \t]*/.exec(line)![0].length > atMost) {
      continue;
    }
    return i;
  }
  return -1;
}

/** The list item `index` hangs off, or none. */
function anchor(
  lines: readonly string[],
  index: number,
  atMost: number,
  dialect: Dialect,
): ListItem | undefined {
  const at = anchorIndex(lines, index, atMost);
  return at < 0 ? undefined : listItem(lines[at], dialect);
}

/**
 * The indentation Tab should give line `index`, or none to leave Tab alone.
 *
 * None also covers the item that is already as deep as it can legally go:
 * indenting it further does not nest it, it just adds whitespace the formatter
 * takes back out.
 */
export function indentTarget(
  lines: readonly string[],
  index: number,
  dialect: Dialect = "markdown",
): string | undefined {
  const current = listItem(lines[index], dialect);
  // A quote is not a level. `>>` nests it, and indenting the `>` turns the
  // whole block into an indented code block instead.
  if (!current || current.marker === ">") {
    return undefined;
  }
  const parent = anchor(lines, index, current.indent.length, dialect);
  if (!parent || current.indent.length >= parent.contentColumn) {
    return undefined;
  }
  return " ".repeat(parent.contentColumn);
}

/**
 * The indentation Shift+Tab should give line `index`, or none to leave it
 * alone.
 *
 * The target is the enclosing item's own indentation, so the line becomes its
 * sibling rather than landing on a column no level uses. With no enclosing
 * item there is still somewhere to go -- the left margin -- because an
 * over-indented first item is exactly what this undoes.
 */
export function outdentTarget(
  lines: readonly string[],
  index: number,
  dialect: Dialect = "markdown",
): string | undefined {
  const current = listItem(lines[index], dialect);
  if (!current || current.marker === ">" || current.indent.length === 0) {
    return undefined;
  }
  const parent = anchor(lines, index, current.indent.length - 1, dialect);
  return parent ? parent.indent : "";
}

/**
 * Continue the list on a new line, or rewrite this line to end it.
 *
 * `also` is whatever else on neighbouring lines has to move in the same edit --
 * a checkbox the text took with it, a blank quoted line the quote no longer
 * needs. One edit rather than two, so one Ctrl+Z takes the whole keystroke back.
 */
export type EnterAction =
  | { kind: "continue"; text: string; also: Rewrite[] }
  | { kind: "replace"; text: string; also: Rewrite[] };

/**
 * The nearest sibling's number, if this item has one at the same level.
 *
 * Only a sibling counts: the item above a nested first item is its parent, and
 * `1. a` / `   1. b` are two lists that number independently.
 */
function siblingNumber(
  lines: readonly string[],
  index: number,
  item: ListItem,
  dialect: Dialect,
): number | undefined {
  const previous = anchor(lines, index, item.indent.length, dialect);
  if (!previous || previous.indent.length !== item.indent.length) {
    return undefined;
  }
  const ordered = ORDERED.exec(previous.marker);
  return ordered ? Number(ordered[1]) : undefined;
}

/**
 * The marker the next item gets.
 *
 * Ordered lists count up, except in a list that is already written entirely as
 * `1.` -- CommonMark renders that one 1, 2, 3 anyway, `poly fmt` keeps both
 * spellings, and rewriting somebody's chosen style is not Enter's job. The
 * file's own second item is the only evidence of which style it is, so the
 * first Enter in a fresh list counts up.
 */
function nextMarker(
  lines: readonly string[],
  index: number,
  item: ListItem,
  dialect: Dialect,
): string {
  const ordered = ORDERED.exec(item.marker);
  if (!ordered) {
    return item.marker;
  }
  const number = Number(ordered[1]);
  return siblingNumber(lines, index, item, dialect) === number
    ? item.marker
    : `${number + 1}${ordered[2]}`;
}

/** A span on one line to rewrite, as columns. */
export interface Rewrite {
  line: number;
  start: number;
  end: number;
  text: string;
}

/**
 * The gap between `marker` and the content that follows it.
 *
 * Taken from the column the content starts at rather than copied verbatim,
 * because the marker being written is not always as wide as the one it follows:
 * after `9.  item` the next marker is `10.`, and copying two spaces would put
 * its content at column 5 where the list's is at 4. That column is where a
 * child of the item begins, so a list whose items disagree about it is a list
 * Tab cannot nest under consistently.
 */
function gap(item: ListItem, marker: string): string {
  return " ".repeat(
    Math.max(1, item.contentColumn - item.indent.length - marker.length),
  );
}

/**
 * Renumber the ordered siblings at `indent`, from line `index` on, counting
 * from `first`.
 *
 * Stops at the first line that is not one of them: a paragraph, a shallower
 * item, a bullet where the numbers were, or a different delimiter -- each of
 * those is a different list, not this one's tail.
 */
function renumberRun(
  lines: readonly string[],
  index: number,
  indent: number,
  delimiter: string,
  first: number,
  dialect: Dialect,
): Rewrite[] {
  const out: Rewrite[] = [];
  let number = first;
  for (let i = index; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      continue; // a loose list keeps counting across the blank lines in it
    }
    if (/^[ \t]*/.exec(line)![0].length > indent) {
      continue; // an item's own wrapped content, or a child list
    }
    const sibling = listItem(line, dialect);
    const ordered = sibling && ORDERED.exec(sibling.marker);
    if (
      !sibling || !ordered || sibling.indent.length !== indent
      || ordered[2] !== delimiter
    ) {
      break;
    }
    const text = `${number}${delimiter}`;
    if (text !== sibling.marker) {
      out.push({
        line: i,
        start: sibling.indent.length,
        end: sibling.indent.length + sibling.marker.length,
        text,
      });
    }
    number++;
  }
  return out;
}

/**
 * The trailing siblings that stop being right once an item is inserted after
 * line `index`.
 *
 * Inserting `3.` in front of an existing `3.` leaves two of them. CommonMark
 * renders the list 1, 2, 3, 4 either way, so nothing looks wrong until `poly
 * fmt` runs and renumbers -- and a keystroke whose work the formatter undoes is
 * exactly what this module exists not to do.
 *
 * A list written entirely as `1.` renumbers to nothing, because there is
 * nothing counting: `nextMarker` keeps that style and so does the formatter.
 */
export function renumberedTail(
  lines: readonly string[],
  index: number,
  dialect: Dialect = "markdown",
): Rewrite[] {
  const item = listItem(lines[index], dialect);
  if (!item) {
    return [];
  }
  const marker = nextMarker(lines, index, item, dialect);
  const inserted = ORDERED.exec(marker);
  // Unordered, or the all-`1.` style where the marker did not move.
  if (!inserted || marker === item.marker) {
    return [];
  }
  return renumberRun(
    lines,
    index + 1,
    item.indent.length,
    inserted[2],
    Number(inserted[1]) + 1,
    dialect,
  );
}

/**
 * The markers that stop being right once line `index` is re-indented to
 * `indent`.
 *
 * Tab and Shift+Tab move an item between two lists, and both of them then count
 * wrong: the one it left is short an item, and the one it joined has a number
 * from somewhere else in it. `poly fmt` renumbers both, so leaving them is the
 * same defect `renumberedTail` exists to avoid -- a keystroke the formatter
 * undoes.
 *
 * The spans are in the coordinates of `lines` as given, so the caller can apply
 * them in the same edit as the indentation change.
 */
export function renumberedAfterMove(
  lines: readonly string[],
  index: number,
  indent: string,
  dialect: Dialect = "markdown",
): Rewrite[] {
  const before = listItem(lines[index], dialect);
  if (!before) {
    return [];
  }
  // Every decision below is about the document the move produces, not the one
  // it starts from: which items are siblings is exactly what the move changes.
  const after = lines.slice();
  after[index] = indent + lines[index].slice(before.indent.length);
  const item = listItem(after[index], dialect);
  const ordered = item && ORDERED.exec(item.marker);
  if (!item || !ordered) {
    return []; // a bullet belongs to no numbering, on either side of the move
  }
  const out: Rewrite[] = [];

  // The list it joins. A sibling above means counting on from it; anything else
  // -- the new parent, a paragraph, the top of the file -- makes this the first
  // item of its own list, which starts at 1.
  const intoIndex = anchorIndex(after, index, item.indent.length);
  const into = intoIndex < 0 ? undefined : listItem(after[intoIndex], dialect);
  const sibling = into && into.indent.length === item.indent.length ? into : undefined;
  const siblingOrdered = sibling && ORDERED.exec(sibling.marker);
  let marker = `1${ordered[2]}`;
  let counting = true;
  if (sibling && siblingOrdered && siblingOrdered[2] === ordered[2]) {
    const number = Number(siblingOrdered[1]);
    if (siblingNumber(after, intoIndex, sibling, dialect) === number) {
      // The all-`1.` style, same as `nextMarker` reads it: the list is not
      // counting, so joining it means writing what it writes.
      marker = sibling.marker;
      counting = false;
    } else {
      marker = `${number + 1}${ordered[2]}`;
    }
  }
  if (marker !== item.marker) {
    out.push({
      line: index,
      start: item.indent.length,
      end: item.indent.length + item.marker.length,
      text: marker,
    });
  }
  if (counting) {
    out.push(...renumberRun(
      after,
      index + 1,
      item.indent.length,
      ordered[2],
      Number(ORDERED.exec(marker)![1]) + 1,
      dialect,
    ));
  }

  // The list it leaves. The search starts at the moved line rather than above
  // it, because after the move that line is the barrier: an item outdented past
  // its old siblings splits them into two lists, and the second one starts over.
  const from = before.indent.length;
  if (from !== item.indent.length) {
    const left = anchorIndex(after, index + 1, from);
    const last = left < 0 ? undefined : listItem(after[left], dialect);
    const lastOrdered = last && last.indent.length === from
      ? ORDERED.exec(last.marker)
      : null;
    out.push(...renumberRun(
      after,
      index + 1,
      from,
      ordered[2],
      lastOrdered && lastOrdered[2] === ordered[2] ? Number(lastOrdered[1]) + 1 : 1,
      dialect,
    ));
  }

  // The moved line is the one place `after` and `lines` disagree about columns.
  return out.map((rewrite) =>
    rewrite.line === index
      ? { ...rewrite, start: from, end: from + item.marker.length }
      : rewrite
  );
}

/**
 * What Enter should do at the end of line `index`, or none to leave Enter
 * alone.
 *
 * An empty item ends the list rather than producing another empty one: it
 * steps out one level, and steps off the list entirely from the outermost. Two
 * Enters is how everyone already finishes a list, and the alternative is
 * deleting a marker by hand every time.
 */
export function enterAction(
  lines: readonly string[],
  index: number,
  dialect: Dialect,
  column: number = lines[index].length,
): EnterAction | undefined {
  const item = listItem(lines[index], dialect);
  if (!item) {
    return undefined;
  }
  // A task checkbox is part of the marker as far as continuing goes.
  const task = dialect === "markdown" ? TASK.exec(item.content) : null;
  if ((task ? task[2] : item.content) === "") {
    if (dialect === "markdown" && item.marker === ">") {
      return quoteAction(lines, index, item);
    }
    // The enclosing item, not `outdentTarget`: Shift+Tab falls back to the left
    // margin because an over-indented orphan is what it exists to fix, but here
    // no enclosing item means this *is* the outermost level, and the way out of
    // the outermost level is off the list. In yaml the difference is not
    // cosmetic -- a sequence under `items:` has no valid form at column 0.
    const parent = item.indent === ""
      ? undefined
      : anchor(lines, index, item.indent.length - 1, dialect);
    return parent
      ? {
        kind: "replace",
        text: `${parent.indent}${item.marker}${item.spacing || " "}${task ? "[ ] " : ""}`,
        also: [],
      }
      : { kind: "replace", text: "", also: [] };
  }
  const marker = nextMarker(lines, index, item, dialect);
  // A checkbox describes the text next to it. Enter in front of that text
  // leaves an empty item above and moves every word of it down, so the box goes
  // too and the empty half is a fresh, unticked item -- the other way round
  // marks a line with nothing on it done and un-does the task the author
  // actually finished. Splitting *within* the text is a different gesture: both
  // halves have words in them, the first one keeps the box, and the second is
  // new work.
  const boxEnd = item.contentColumn + item.content.length - (task ? task[2].length : 0);
  const moving = task !== null && column >= boxEnd
    && lines[index].slice(boxEnd, column).trim() === ""
    && lines[index].slice(column).trim() !== "";
  const box = task ? `${moving ? task[1] : "[ ]"} ` : "";
  return {
    kind: "continue",
    text: `${item.indent}${marker}${gap(item, marker)}${box}`,
    also: moving && task![1] !== "[ ]"
      ? [{
        line: index,
        start: item.contentColumn,
        end: item.contentColumn + task![1].length,
        text: "[ ]",
      }]
      : [],
  };
}

/**
 * Enter at the end of an empty `>`.
 *
 * A blockquote is the one block where an empty line is content: `> a` / `>` /
 * `> b` is one quote holding two paragraphs, and `poly fmt` keeps it that way.
 * So the first Enter writes the blank quoted line and stays inside the quote,
 * and it takes a second one -- on a line whose predecessor is already blank --
 * to leave. Leaving clears both, because the blank line only existed as a step
 * on the way out.
 *
 * An empty `>` with no quote above it is somebody who typed the marker and
 * changed their mind, so that one leaves immediately.
 */
function quoteAction(
  lines: readonly string[],
  index: number,
  item: ListItem,
): EnterAction {
  const above = index > 0 ? listItem(lines[index - 1], "markdown") : undefined;
  const quoted = above !== undefined && above.marker === ">"
    && above.indent === item.indent;
  if (quoted && above.content !== "") {
    // The whole line is rewritten rather than inserted after, so that the space
    // this line no longer needs goes with it: `> ` with nothing following the
    // marker is trailing whitespace.
    return {
      kind: "replace",
      text: `${item.indent}>\n${item.indent}>${item.spacing || " "}`,
      also: [],
    };
  }
  return {
    kind: "replace",
    text: "",
    also: quoted
      ? [{ line: index - 1, start: 0, end: lines[index - 1].length, text: "" }]
      : [],
  };
}
