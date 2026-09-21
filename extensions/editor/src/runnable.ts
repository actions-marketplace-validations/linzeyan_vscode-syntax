/**
 * Which declaration is a program's entry point, and what poly does about it.
 *
 * poly ships no debugger and starts no process. 01 D6 rules that out and the
 * reasoning still holds: a debugger is a second protocol (DAP) on top of an
 * architecture that routes LSP, Go's is already `golang.go`'s delve, and
 * writing another would not let anyone uninstall anything. What D6 does not
 * cover is the gesture. Running the file you are looking at is two keystrokes
 * and a guess about which launch configuration is selected, and the one place
 * it is obvious what you meant -- the cursor on `func main` -- has no button.
 *
 * So this is a lens and a hand-off: poly decides *where* the button goes and
 * the editor's own Start Debugging decides *what* it runs, out of whatever
 * debug extension the user installed. Nothing here knows how to launch a Go
 * program, or that Go exists.
 */

/** As much of `vscode.DocumentSymbol` as the choice below depends on. */
export interface NamedSymbol {
  readonly name: string;
  readonly kind: number;
  readonly children?: readonly NamedSymbol[];
}

/** `vscode.SymbolKind.Method` and `.Function`, on the editor's side of the -1. */
const METHOD = 5;
const FUNCTION = 11;

/**
 * The kinds an entry point arrives as.
 *
 * A method as well as a function, because Java's and C#'s entry point is a
 * static method on a class rather than a free function.
 */
const CALLABLE: ReadonlySet<number> = new Set([METHOD, FUNCTION]);

/**
 * How deep one can sit.
 *
 * Two, for the same reason: `class Main { static void main(String[]) }` is the
 * entry point of every Java program and it is a child of the class.
 */
const MAX_DEPTH = 2;

/**
 * The names that mean "start here".
 *
 * Go, Rust, C, C++ and Java spell it `main`; C# spells it `Main`. Python is the
 * language this cannot reach: its entry point is `if __name__ == "__main__"`,
 * which is a statement and not a declaration, so no symbol provider reports it.
 */
const ENTRY: ReadonlySet<string> = new Set(["main", "Main"]);

/**
 * The entry points among `symbols`.
 *
 * Name equality and not a prefix or a pattern: `TestMain` is a test harness,
 * `mainLoop` is a function that happens to start with the word, and a lens
 * offering to run either of them would be a lie the user only finds out about
 * after pressing it.
 */
export function entryPoints<T extends NamedSymbol>(symbols: readonly T[]): T[] {
  const found: T[] = [];
  const walk = (level: readonly T[], depth: number) => {
    for (const symbol of level) {
      if (CALLABLE.has(symbol.kind) && ENTRY.has(symbol.name)) {
        found.push(symbol);
      }
      if (depth < MAX_DEPTH && symbol.children) {
        walk(symbol.children as readonly T[], depth + 1);
      }
    }
  };
  walk(symbols, 1);
  return found;
}
