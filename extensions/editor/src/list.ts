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

const TASK = /^\[[ xX]\](?:[ \t]+(?=\S)|[ \t]*$)(.*)$/;
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
 * The list item `index` hangs off, or none.
 *
 * Scanning up skips blank lines (a loose list has them between items) and any
 * line indented past this one -- those are somebody else's wrapped content,
 * not a sibling. A less-indented line that is not a list item ends the search:
 * the item is the first of its list, and a first item has no level to move to.
 */
function anchor(
  lines: readonly string[],
  index: number,
  atMost: number,
  dialect: Dialect,
): ListItem | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") {
      continue;
    }
    if (/^[ \t]*/.exec(line)![0].length > atMost) {
      continue;
    }
    return listItem(line, dialect);
  }
  return undefined;
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

/** Continue the list on a new line, or rewrite this line to end it. */
export type EnterAction =
  | { kind: "continue"; text: string }
  | { kind: "replace"; text: string };

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

/** A marker to rewrite, as a column span on one line. */
export interface Renumber {
  line: number;
  start: number;
  end: number;
  text: string;
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
): Renumber[] {
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
  let number = Number(inserted[1]);
  const out: Renumber[] = [];
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      continue; // a loose list keeps counting across the blank lines in it
    }
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (indent > item.indent.length) {
      continue; // this item's own wrapped content, or a child list
    }
    const sibling = listItem(line, dialect);
    const ordered = sibling && ORDERED.exec(sibling.marker);
    // Anything else ends the list: a paragraph, a shallower item, or a bullet
    // where the numbers were -- that is a different list, not this one's tail.
    if (
      !sibling || !ordered || sibling.indent.length !== item.indent.length
      || ordered[2] !== inserted[2]
    ) {
      break;
    }
    number++;
    const text = `${number}${ordered[2]}`;
    if (text !== sibling.marker) {
      out.push({
        line: i,
        start: sibling.indent.length,
        end: sibling.indent.length + sibling.marker.length,
        text,
      });
    }
  }
  return out;
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
): EnterAction | undefined {
  const item = listItem(lines[index], dialect);
  if (!item) {
    return undefined;
  }
  // A task checkbox is part of the marker as far as continuing goes, and an
  // unticked box is what the next item starts with whichever way this one went.
  const task = dialect === "markdown" ? TASK.exec(item.content) : null;
  const box = task ? "[ ] " : "";
  if ((task ? task[1] : item.content) === "") {
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
        text: `${parent.indent}${item.marker}${item.spacing || " "}${box}`,
      }
      : { kind: "replace", text: "" };
  }
  const marker = nextMarker(lines, index, item, dialect);
  return {
    kind: "continue",
    text: `${item.indent}${marker}${item.spacing || " "}${box}`,
  };
}
