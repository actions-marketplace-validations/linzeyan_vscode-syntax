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
  const found = at < 0 ? undefined : listItem(lines[at], dialect);
  // A quote is not a level, on either side of the question. `indentTarget`
  // already refuses to indent a `>`; being indented *under* one is the same
  // mistake seen from below -- two spaces do not put a list inside a quote,
  // they only move it, and the formatter puts it straight back. So a quoted
  // line is a wall the way a paragraph is.
  return found && found.marker === ">" ? undefined : found;
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
 * The last line that belongs to the item at `index`.
 *
 * An item is not one line. Everything indented to its content column is part of
 * it -- the wrapped remainder of its paragraph, its child lists, their children
 * -- and moving the marker without moving that leaves it behind, attached to
 * whatever item now owns the column it sits at. A blank line only counts when
 * something deeper follows it, because a loose list keeps going across one but
 * the blank line after the last child belongs to what comes next.
 */
export function itemExtent(
  lines: readonly string[],
  index: number,
  dialect: Dialect = "markdown",
): number {
  const item = listItem(lines[index], dialect);
  if (!item) {
    return index;
  }
  let last = index;
  for (let i = index + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      continue;
    }
    if (/^[ \t]*/.exec(lines[i])![0].length < item.contentColumn) {
      break;
    }
    last = i;
  }
  return last;
}

/**
 * The marker the item at `index` carries once it sits at `indent`.
 *
 * Only what is above the item decides this -- which list it lands in, and what
 * the item before it is numbered -- so it can be answered before anything below
 * the item has been touched. That order is the point: `movedWith` needs the
 * marker's width to know how far the item's children move, and
 * `renumberedAfterMove` needs the children already moved before it can tell a
 * child from a sibling. Answering the narrow question first breaks the circle.
 *
 * `counting` is false for the all-`1.` style, which is not a list that counts.
 */
function markerAfterMove(
  lines: readonly string[],
  index: number,
  indent: string,
  dialect: Dialect,
): { item: ListItem; delimiter: string; marker: string; counting: boolean } | undefined {
  const before = listItem(lines[index], dialect);
  if (!before) {
    return undefined;
  }
  const after = lines.slice();
  after[index] = indent + lines[index].slice(before.indent.length);
  const item = listItem(after[index], dialect);
  const ordered = item && ORDERED.exec(item.marker);
  if (!item || !ordered) {
    return undefined;
  }
  // A sibling above means counting on from it; anything else -- the new parent,
  // a paragraph, the top of the file -- makes this the first item of its own
  // list, which starts at 1.
  const intoIndex = anchorIndex(after, index, item.indent.length);
  const into = intoIndex < 0 ? undefined : listItem(after[intoIndex], dialect);
  const sibling = into && into.indent.length === item.indent.length ? into : undefined;
  const siblingOrdered = sibling && ORDERED.exec(sibling.marker);
  if (sibling && siblingOrdered && siblingOrdered[2] === ordered[2]) {
    const number = Number(siblingOrdered[1]);
    return siblingNumber(after, intoIndex, sibling, dialect) === number
      // The all-`1.` style, same as `nextMarker` reads it: the list is not
      // counting, so joining it means writing what it writes.
      ? { item, delimiter: ordered[2], marker: sibling.marker, counting: false }
      : { item, delimiter: ordered[2], marker: `${number + 1}${ordered[2]}`, counting: true };
  }
  return { item, delimiter: ordered[2], marker: `1${ordered[2]}`, counting: true };
}

/**
 * The rest of the item, moved by the same amount as its marker.
 *
 * Shifting by the difference rather than re-indenting to a column, because the
 * lines being moved are at every depth under the item and the shape among them
 * is the thing being preserved. Blank lines are skipped: a line of spaces is
 * whitespace the formatter removes, not structure to keep.
 *
 * The difference is between content columns, not between indents, because the
 * marker changes width on the way: `11. item` joining a list at 1 becomes
 * `4. item`, whose content -- and so whose children -- sit one column further
 * left than the indent alone says.
 */
export function movedWith(
  lines: readonly string[],
  index: number,
  indent: string,
  dialect: Dialect = "markdown",
): Rewrite[] {
  const item = listItem(lines[index], dialect);
  if (!item) {
    return [];
  }
  const moved = markerAfterMove(lines, index, indent, dialect);
  const marker = moved ? moved.marker : item.marker;
  const content = indent.length + marker.length + Math.max(1, item.spacing.length);
  const extent = itemExtent(lines, index, dialect);
  const out = shift(lines, index + 1, extent, content - item.contentColumn);

  // Outdenting ends the list the item was in: everything still sitting at the
  // old indent is below a shallower marker now, which makes it this item's
  // content whether anyone meant it or not. So it lands at the item's new
  // content column -- one uniform shift, which keeps the shape among those
  // lines and leaves `renumberedAfterMove` numbering them from 1, as the fresh
  // child list they have become. Indenting is not the same question: the list
  // the item left is still there at its own column, and its remaining items are
  // still in it.
  if (indent.length < item.indent.length) {
    let last = extent;
    for (let i = extent + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") {
        continue;
      }
      if (/^[ \t]*/.exec(lines[i])![0].length < item.indent.length) {
        break;
      }
      last = i;
    }
    out.push(...shift(lines, extent + 1, last, content - item.indent.length));
  }
  return out;
}

/** Every line in `from..=to` moved sideways by `delta` columns. */
function shift(
  lines: readonly string[],
  from: number,
  to: number,
  delta: number,
): Rewrite[] {
  const out: Rewrite[] = [];
  for (let i = from; delta !== 0 && i <= to; i++) {
    if (lines[i].trim() === "") {
      continue;
    }
    const leading = /^[ \t]*/.exec(lines[i])![0].length;
    out.push(
      delta > 0
        ? { line: i, start: 0, end: 0, text: " ".repeat(delta) }
        : { line: i, start: 0, end: Math.min(-delta, leading), text: "" },
    );
  }
  return out;
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
  counting = true,
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
      // A marker that changes width moves the item's content column with it,
      // and its children have to follow: `9.` becoming `10.` leaves a child at
      // column 3 outside an item whose content now starts at 4, which reads as
      // the child having been promoted to the list the parent is in.
      out.push(...shift(
        lines,
        i + 1,
        itemExtent(lines, i, dialect),
        text.length - sibling.marker.length,
      ));
    }
    if (counting) {
      number++;
    }
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

/** The delimiter the list at `indent` is written with, from `index` on. */
function delimiterAt(
  lines: readonly string[],
  index: number,
  indent: number,
  dialect: Dialect,
): string | undefined {
  for (let i = index; i < lines.length; i++) {
    if (lines[i].trim() === "" || /^[ \t]*/.exec(lines[i])![0].length > indent) {
      continue;
    }
    const item = listItem(lines[i], dialect);
    const ordered = item && item.indent.length === indent && ORDERED.exec(item.marker);
    return ordered ? ordered[2] : undefined;
  }
  return undefined;
}

/**
 * The number an item arriving at `indent` above line `index` would take, or
 * none when the list there is not one that counts.
 *
 * None is the all-`1.` style, which `nextMarker` and `markerAfterMove` already
 * read the same way: nothing is counting, so nothing is out of step, and
 * renumbering it would be rewriting a style the author chose and `poly fmt`
 * keeps. 1 is a list that does not exist yet.
 */
function continuesFrom(
  lines: readonly string[],
  index: number,
  indent: number,
  delimiter: string,
  dialect: Dialect,
): number | undefined {
  const at = anchorIndex(lines, index, indent);
  const last = at < 0 ? undefined : listItem(lines[at], dialect);
  const ordered = last && last.indent.length === indent ? ORDERED.exec(last.marker) : null;
  if (!last || !ordered || ordered[2] !== delimiter) {
    return 1;
  }
  const number = Number(ordered[1]);
  return siblingNumber(lines, at, last, dialect) === number ? undefined : number + 1;
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
  // A bullet belongs to no numbering itself, but moving one still moves a
  // barrier: a `- delta` between two ordered lists is what kept them two, and
  // indenting it away lets the second go on counting from the first.
  const moved = markerAfterMove(lines, index, indent, dialect);
  const marker = moved ? moved.marker : before.marker;
  const out: Rewrite[] = [];
  if (moved && marker !== moved.item.marker) {
    out.push({
      line: index,
      start: indent.length,
      end: indent.length + moved.item.marker.length,
      text: marker,
    });
  }

  // Every run below reads the document the whole move produces, children and
  // all. Reading the one where only the marker moved gets two things wrong:
  // indenting `6. one` under `5. gamma` puts it at column 3, which is exactly
  // where its own `1. note` was sitting, and a child read as a sibling is
  // renumbered into its parent's list.
  const joined = lines.slice();
  joined[index] = indent + marker
    + lines[index].slice(before.indent.length + before.marker.length);
  // How far each of those lines moved, so the spans found in that document can
  // be handed back in the coordinates of this one. Without it a renumbering
  // lands one column to the right of the marker it meant to replace and writes
  // `21.alpha` -- the spans are applied to the document as it is now, all of
  // them against the same snapshot, which is the whole reason they are spans.
  const moves = new Map<number, number>();
  for (const span of movedWith(lines, index, indent, dialect)) {
    joined[span.line] = joined[span.line].slice(0, span.start) + span.text
      + joined[span.line].slice(span.end);
    moves.set(span.line, span.text.length - (span.end - span.start));
  }
  const runs: Rewrite[] = [];

  // The list it joins.
  if (moved && moved.counting) {
    runs.push(...renumberRun(
      joined,
      index + 1,
      indent.length,
      moved.delimiter,
      Number(ORDERED.exec(marker)![1]) + 1,
      dialect,
    ));
  }

  // The list it leaves, which is only still a list when the item moved right:
  // outdenting puts a shallower marker above those items, and `movedWith` has
  // already carried them to the item's content column, where they go on from
  // whatever its own children counted to -- 1 when it has none. The search
  // starts below the item's own content rather than at the item, because that
  // content is at the same column now and is not what stopped being right.
  const from = before.indent.length;
  const content = indent.length + marker.length + Math.max(1, before.spacing.length);
  const outdented = indent.length < from;
  const at = outdented ? itemExtent(lines, index, dialect) + 1 : index + 1;
  const column = outdented ? content : from;
  // The moved item's own delimiter when it has one; otherwise whichever the
  // list left behind is written with, since that is the list being renumbered.
  const delimiter = moved ? moved.delimiter : delimiterAt(joined, at, column, dialect);
  if (from !== indent.length && delimiter !== undefined) {
    const first = continuesFrom(joined, at, column, delimiter, dialect);
    // Landing in a list that is not counting means writing what it writes.
    // These items carried numbers in from the list they were in, so unlike the
    // items already in the all-`1.` list above -- which are left alone because
    // they are already right -- these have to be rewritten to match the style.
    if (first !== undefined || outdented) {
      runs.push(
        ...renumberRun(joined, at, column, delimiter, first ?? 1, dialect, first !== undefined),
      );
    }
  }
  out.push(...runs.map((rewrite) => {
    const shift = moves.get(rewrite.line) ?? 0;
    return shift === 0
      ? rewrite
      : { ...rewrite, start: rewrite.start - shift, end: rewrite.end - shift };
  }));

  // The moved line is the other place `joined` and `lines` disagree, and the
  // only one where the marker itself is what moved.
  return out.map((rewrite) =>
    rewrite.line === index
      ? { ...rewrite, start: from, end: from + before.marker.length }
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
  // An item whose content carries on below this line is not finished, so Enter
  // in the middle of it is a paragraph break rather than a new item: inserting
  // a marker here would leave the rest of the item hanging off it at a column
  // that is no longer its own. Enter belongs to this module only at the end of
  // the item, which for almost every item is this line.
  if (!item || itemExtent(lines, index, dialect) !== index) {
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
