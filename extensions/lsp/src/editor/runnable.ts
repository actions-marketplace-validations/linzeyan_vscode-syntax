/**
 * Which declaration is a program's entry point, and what poly does about it.
 *
 * poly ships no debugger. 01 D6 rules that out and the reasoning still holds:
 * a debugger is a second protocol (DAP) on top of an architecture that routes
 * LSP, Go's is already `golang.go`'s delve, and writing another would not let
 * anyone uninstall anything. `debug` therefore hands over to whatever debug
 * extension is installed, exactly as F5 does.
 *
 * `run` used to hand over too, to `workbench.action.debug.run` -- "Start
 * Without Debugging", which still goes through a debug adapter, still wants a
 * launch configuration, and still puts the debug toolbar on screen. Two
 * buttons, one behaviour, and the one labelled `run` was the one lying. So D6
 * is narrowed rather than kept: poly starts one process, the one the user just
 * pressed a button labelled `run` on, in a visible terminal they can read and
 * kill. It does not attach to it, supervise it, or keep anything alive.
 *
 * That costs poly a small amount of knowledge it did not have before -- how
 * four languages are run from a shell. `RUN_LINES` is all of it, and the lens
 * only offers `run` where there is an entry in it.
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
 * Go, Rust, C, C++ and Java spell it `main`; C# spells it `Main`.
 */
const ENTRY: ReadonlySet<string> = new Set(["main", "Main"]);

/**
 * Languages whose entry point is not a declaration at all.
 *
 * Python's is `if __name__ == "__main__"`, a statement, so no symbol provider
 * reports it -- and a `def main` without that guard is a function nothing
 * calls, so putting the button there would offer to run a file that does
 * nothing. A shell script's entry point is the file: there is no declaration
 * to sit on, and `main()` is a convention some scripts follow and most do not.
 *
 * The shebang is the filter, and it is the script's own statement of intent.
 * Without one a `.sh` is usually something another script sources, and a run
 * button over a library is an offer to run nothing.
 *
 * A language in here uses only this rule: `entryPoints` is not consulted for
 * it, so a Python file does not end up with a button on `def main` as well as
 * on the guard that calls it.
 */
const TEXT_ENTRY: ReadonlyMap<string, RegExp> = new Map([
  ["python", /^if\s+__name__\s*==\s*(['"])__main__\1\s*:/m],
  ["shellscript", /^#!.*\b(?:bash|dash|ksh|zsh|sh)\b/],
]);

/** Is this a language whose entry point is found in the text? */
export function findsEntryInText(languageId: string): boolean {
  return TEXT_ENTRY.has(languageId);
}

/**
 * The interpreter a script asked for, by name.
 *
 * Taken from the shebang rather than assumed to be bash. A `#!/bin/zsh` script
 * run under bash is a different language with similar syntax, and the ways it
 * differs -- arrays indexed from one, word splitting, `setopt` -- are exactly
 * the ways a script breaks quietly rather than loudly.
 */
export function interpreterOf(text: string): string | undefined {
  return /^#!.*?\b(bash|dash|ksh|zsh|sh)\b/.exec(text)?.[1];
}

/**
 * How to run a file from a shell, per language, run from the file's directory.
 *
 * Four, and the list is short on purpose. C, C++, Java and C# have entry
 * points this file already finds, and running one means compiling first --
 * with flags, an output path and a toolchain poly would have to have opinions
 * about. They get `debug` only, which is the honest answer: the extension that
 * knows how to build them is the one that should.
 *
 * `go run .` and `cargo run` take the directory rather than the file, because
 * a main package is rarely one file and `go run main.go` fails on the first
 * symbol defined next door. cargo searches upward for the manifest, so the
 * file's own directory is enough for both.
 */
type RunLine = (file: string, text: string, windows: boolean) => string;

const RUN_LINES: ReadonlyMap<string, RunLine> = new Map<string, RunLine>([
  ["go", () => "go run ."],
  ["rust", () => "cargo run"],
  // python3 is the name that means python 3 everywhere except Windows,
  // where the installer writes `python` and `python3` is a Store stub that
  // opens the Store.
  ["python", (file, _text, windows) => `${windows ? "python" : "python3"} "${file}"`],
  ["shellscript", (file, text) => `${interpreterOf(text) ?? "sh"} "${file}"`],
]);

/**
 * The command line for running `fileName`, or nothing if poly does not know.
 *
 * `fileName` is the base name, not the path: the caller runs this in the
 * file's own directory, which keeps the line short enough to read in a
 * terminal and sidesteps most of what quoting a full path would involve. It is
 * still quoted, because a base name can contain a space.
 */
export function runLine(
  languageId: string,
  fileName: string,
  text: string,
  windows: boolean,
): string | undefined {
  return RUN_LINES.get(languageId)?.(fileName, text, windows);
}

/**
 * The line the entry point is on, for a language that has no declaration for it.
 *
 * Zero-based, and `undefined` when the file has no entry point -- which is most
 * Python files and most shell files, and is the answer that keeps the button
 * off a module nobody runs.
 */
export function entryLine(languageId: string, text: string): number | undefined {
  const pattern = TEXT_ENTRY.get(languageId);
  const found = pattern?.exec(text);
  if (!found) {
    return undefined;
  }
  // The index counts characters, and a lens wants a line. Everything before
  // the match, split -- the last piece is the matched line itself.
  return text.slice(0, found.index).split("\n").length - 1;
}

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
