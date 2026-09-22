/**
 * What a reference row says before it says the code.
 *
 * `references.ts` decides which declarations get a lens and how the count is
 * worded; this decides what the list looks like once the lens is clicked. Two
 * files because they are two features that happen to share a noun -- one runs
 * on every visible declaration, the other once per click.
 *
 * The built-in `references-view` prints one line of source per hit with the
 * file name on the group above it. That is enough to recognise a hit you are
 * already looking for and not enough to read a list: "which of these forty is
 * the one on the interface" and "is this a call or a declaration" are both
 * answerable from the line number and the enclosing symbol, and neither is on
 * screen. poly cannot add a column to somebody else's tree -- a
 * `TreeDataProvider` owns its rows -- so it has its own.
 *
 * This half has no `vscode` import, which is what lets node's test runner load
 * it without booting an editor.
 */

/**
 * As much of `vscode.DocumentSymbol` as the functions below depend on.
 *
 * Lines rather than a `Range`, because containment is the only question asked
 * and a column never changes the answer: a reference is inside a function or it
 * is not, and the function's first and last line decide that.
 */
export interface TreeSymbol {
  readonly name: string;
  readonly kind: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly children?: readonly TreeSymbol[];
}

/**
 * `vscode.SymbolKind` as a word, for the column between the line number and the
 * code.
 *
 * Numbers rather than the enum, for the reason `references.ts` uses numbers:
 * this module has no `vscode` import, which is what lets node's test runner
 * load it. Every value here is on the editor's side of the wire protocol's -1.
 *
 * `func` and `var` rather than `function` and `variable` because the column is
 * read at a glance beside a line number and those two are far and away the most
 * common rows in any result set. The rest stay spelled out: `enum member` earns
 * its four extra characters and nobody reads `ctor`.
 */
const KINDS: ReadonlyMap<number, string> = new Map([
  [0, "file"],
  [1, "module"],
  [2, "namespace"],
  [3, "package"],
  [4, "class"],
  [5, "method"],
  [6, "property"],
  [7, "field"],
  [8, "constructor"],
  [9, "enum"],
  [10, "interface"],
  [11, "func"],
  [12, "var"],
  [13, "const"],
  [14, "string"],
  [15, "number"],
  [16, "boolean"],
  [17, "array"],
  [18, "object"],
  [19, "key"],
  [20, "null"],
  [21, "enum member"],
  [22, "struct"],
  [23, "event"],
  [24, "operator"],
  [25, "type param"],
]);

/**
 * The word for a symbol kind, or `undefined` for one this does not know.
 *
 * `undefined` rather than a guess or the number itself: a server is free to
 * send a kind outside the enum, and a column reading `27` tells the reader
 * strictly less than an empty one.
 */
export function kindName(kind: number): string | undefined {
  return KINDS.get(kind);
}

/**
 * The innermost symbol containing `line`, if any.
 *
 * Innermost and not outermost: a reference inside a method of a class is
 * reported as being in the method. The class is the answer to a question nobody
 * asked -- every row in that file would say the same thing.
 *
 * `undefined` is an ordinary answer rather than a failure. A reference in an
 * import block, in a top-level statement, or in a file whose language has no
 * symbol provider is inside nothing, and a row that said `file` for those would
 * be inventing a level that is not there.
 */
export function enclosing(
  symbols: readonly TreeSymbol[],
  line: number,
): TreeSymbol | undefined {
  let found: TreeSymbol | undefined;
  const walk = (level: readonly TreeSymbol[]) => {
    for (const symbol of level) {
      if (line < symbol.startLine || line > symbol.endLine) {
        continue;
      }
      // Assigned before the recursion so a symbol with no children still
      // counts, and overwritten by anything deeper that also contains the line.
      found = symbol;
      if (symbol.children) {
        walk(symbol.children);
      }
      // Sibling ranges do not overlap, so the first container is the only one.
      return;
    }
  };
  walk(symbols);
  return found;
}

/**
 * The two columns a row carries in front of the code.
 *
 * One function rather than two, because this is where the shape of a row is
 * decided and splitting it would put half the decision at the call site. The
 * line number is 1-based: that is the number in the editor's gutter and the one
 * a `path:line` reference uses, while everything in the protocol around it
 * counts from zero.
 *
 * The symbol's name comes along with its kind, because "which func" is the
 * question the kind alone leaves open and the name is already in hand.
 */
export function rowPrefix(
  line: number,
  symbol: TreeSymbol | undefined,
): { readonly number: string; readonly kind: string } {
  const kind = symbol && kindName(symbol.kind);
  return {
    number: `${line + 1}`,
    kind: kind ? `${kind} ${symbol.name}` : "",
  };
}
