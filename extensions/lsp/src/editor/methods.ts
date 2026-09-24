/**
 * `N methods` over a type whose methods are not inside it.
 *
 * The count every other lens here needs a language server for, this
 * one already has: it is in the document symbols the outline is drawn from. No
 * extra request, and nothing resolved lazily -- the number is known before the
 * lens is handed over.
 *
 * It exists because of where Go puts a method. Measured against gopls 0.23
 * (2026-09-21), `textDocument/documentSymbol` reports `Circle`'s fields as its
 * children and its methods as siblings, named `(Circle).Area`. So the methods
 * of a Go type are scattered through the file with nothing above the type to
 * say how many there are or where they went, which is the gap this fills.
 *
 * A language that nests methods inside the type gets no lens at all, and that
 * is the rule rather than a gap: the methods of a TypeScript class are the
 * lines under it, and a count of what is already on screen is furniture.
 */

/** As much of `vscode.DocumentSymbol` as the choice below depends on. */
export interface MethodSymbol {
  readonly name: string;
  readonly kind: number;
}

/** `vscode.SymbolKind.Method`, on the editor's side of the wire's -1. */
const METHOD = 5;

/**
 * gopls's name for a method: the receiver in parentheses, then a dot.
 *
 * `(Circle).Area` for a value receiver and `(*Circle).Save` for a pointer one,
 * and the star is not part of the type's name. Generic receivers arrive as
 * `(Tree[T]).Insert`, so the capture runs to the closing paren rather than
 * stopping at a word boundary.
 */
const RECEIVER = /^\((\*?)([^)]+)\)\./;

/**
 * The type `name` declares a method on, if it declares one at all.
 *
 * Two conventions, both measured, both the server's own naming rather than
 * anything parsed out of the source. gopls writes a receiver in parentheses;
 * `buf lsp serve` writes a fully qualified path, so `service Greeter`'s rpcs
 * arrive as `greet.v1.Greeter.SayHello` beside `greet.v1.Greeter` rather than
 * inside it. A server that nests its methods matches neither and gets no lens,
 * which is the right answer for it -- see the file comment.
 */
export function receiverOf(name: string): string | undefined {
  const found = RECEIVER.exec(name);
  if (found) {
    // `(Tree[T]).Insert` is a method on `Tree`; the symbol provider reports the
    // type with its parameters and the declaration without them.
    return found[2].replace(/\[.*$/, "");
  }
  // The qualified form. Only the last segment is dropped: the rest is the type,
  // package and all, which is exactly how the type's own symbol is named. A
  // name that opened a paren and never closed it is a receiver this file failed
  // to read, not a qualified path, and must not fall through to here.
  const dot = name.lastIndexOf(".");
  return !name.startsWith("(") && dot > 0 ? name.slice(0, dot) : undefined;
}

/**
 * The methods in the file's own top-level symbols, by the type they are on.
 *
 * Top-level only, because that is where the ones worth counting are: a method
 * that is a child of the type is already under the reader's eye, and one
 * nested deeper than the file is somebody's local function.
 *
 * One pass for the whole file rather than a filter per type: the lens asks for
 * every declaration it draws, on every edit, and a filter each was declarations
 * times symbols -- ninety thousand receiver parses for a generated stub.
 */
export function methodsByType<T extends MethodSymbol>(file: readonly T[]): Map<string, T[]> {
  const byType = new Map<string, T[]>();
  for (const symbol of file) {
    const type = symbol.kind === METHOD ? receiverOf(symbol.name) : undefined;
    if (type !== undefined) {
      byType.set(type, [...(byType.get(type) ?? []), symbol]);
    }
  }
  return byType;
}

/** What the method lens says. Never zero: no lens is drawn for no methods. */
export function methodLabel(count: number): string {
  return count === 1 ? "1 method" : `${count} methods`;
}
