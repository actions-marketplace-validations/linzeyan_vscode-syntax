import * as assert from "node:assert/strict";
import { test } from "node:test";

import { entryLine, entryPoints, findsEntryInText, interpreterOf, runLine } from "./runnable";

const FUNCTION = 11;
const METHOD = 5;
const CLASS = 4;
const VARIABLE = 12;

interface TestSymbol {
  name: string;
  kind: number;
  children: TestSymbol[];
}

const symbol = (
  name: string,
  kind: number,
  children: TestSymbol[] = [],
): TestSymbol => ({ name, kind, children });

test("a top-level main is the entry point", () => {
  const file = [
    symbol("serve", FUNCTION),
    symbol("main", FUNCTION),
  ];
  assert.deepEqual(entryPoints(file).map((s) => s.name), ["main"]);
});

test("Java's entry point is a method on a class", () => {
  const file = [symbol("App", CLASS, [symbol("main", METHOD), symbol("run", METHOD)])];
  assert.deepEqual(entryPoints(file).map((s) => s.name), ["main"]);
});

test("a name that merely starts with main is not one", () => {
  // `TestMain` is Go's test harness and `mainLoop` is an ordinary function. A
  // run button over either is a promise the user only finds out is false after
  // pressing it.
  const file = [
    symbol("TestMain", FUNCTION),
    symbol("mainLoop", FUNCTION),
    symbol("domain", FUNCTION),
  ];
  assert.deepEqual(entryPoints(file), []);
});

test("a variable called main is not runnable", () => {
  const file = [symbol("main", VARIABLE)];
  assert.deepEqual(entryPoints(file), []);
});

test("C# capitalises it", () => {
  const file = [symbol("Program", CLASS, [symbol("Main", METHOD)])];
  assert.deepEqual(entryPoints(file).map((s) => s.name), ["Main"]);
});

test("Python's entry point is a statement, so it is found in the text", () => {
  const file = "import sys\n\n\ndef main():\n    pass\n\n\nif __name__ == \"__main__\":\n    main()\n";
  assert.equal(entryLine("python", file), 7);
  assert.equal(entryLine("python", "if __name__ == '__main__':\n"), 0);
  // No guard: `def main` is a function nothing calls, and running the file
  // does nothing. A button there would be an offer the file cannot keep.
  assert.equal(entryLine("python", "def main():\n    pass\n"), undefined);
});

test("a shell script's entry point is the shebang, or it has none", () => {
  assert.equal(entryLine("shellscript", "#!/usr/bin/env bash\nset -eu\n"), 0);
  assert.equal(entryLine("shellscript", "#!/bin/sh\n"), 0);
  assert.equal(entryLine("shellscript", "#!/usr/bin/env zsh\n"), 0);
  // Something another script sources. A run button over a library offers to
  // run nothing.
  assert.equal(entryLine("shellscript", "log() { echo \"$@\"; }\n"), undefined);
  // A shebang that is not a shell is not this language's entry point.
  assert.equal(entryLine("shellscript", "#!/usr/bin/env python3\n"), undefined);
});

test("the two rules never both apply to one language", () => {
  // Python has `def main` symbols and Go does not have a text rule, so a
  // language answering yes here must not also be walked for declarations --
  // otherwise a Python file gets a button on the guard and on the function it
  // calls.
  assert.equal(findsEntryInText("python"), true);
  assert.equal(findsEntryInText("shellscript"), true);
  assert.equal(findsEntryInText("go"), false);
  assert.equal(entryLine("go", "func main() {}\n"), undefined);
});

test("a local named main inside a function is not the program's entry", () => {
  // Depth two is Java's class; depth three is somebody's closure.
  const file = [
    symbol("outer", FUNCTION, [symbol("helper", FUNCTION, [symbol("main", FUNCTION)])]),
  ];
  assert.deepEqual(entryPoints(file), []);
});

test("run lines take the directory where the tool does", () => {
  // Not `go run main.go`: a main package is rarely one file, and naming one
  // fails on the first symbol defined next door -- which reads as a broken
  // button rather than as the wrong command.
  assert.equal(runLine("go", "main.go", "", false), "go run .");
  assert.equal(runLine("rust", "main.rs", "", false), "cargo run");
});

test("a script is run under the interpreter its shebang asked for", () => {
  assert.equal(runLine("shellscript", "d.sh", "#!/bin/zsh\n", false), "zsh \"d.sh\"");
  assert.equal(runLine("shellscript", "d.sh", "#!/usr/bin/env bash\n", false), "bash \"d.sh\"");
  // The lens only appears for a file with a shebang, so this is the path
  // taken by the command palette on a .sh without one.
  assert.equal(runLine("shellscript", "d.sh", "echo hi\n", false), "sh \"d.sh\"");
});

test("python3 everywhere, python on Windows", () => {
  assert.equal(runLine("python", "app.py", "", false), "python3 \"app.py\"");
  // `python3` on Windows is a Store stub that opens the Store rather than
  // running anything.
  assert.equal(runLine("python", "app.py", "", true), "python \"app.py\"");
});

test("a name with a space stays one argument", () => {
  assert.equal(runLine("python", "my app.py", "", false), "python3 \"my app.py\"");
});

// C, C++, Java and C# have entry points `entryPoints` finds, and no one-line
// way to run them. The lens draws `debug` alone for those rather than a `run`
// that opens a terminal and prints a compiler error.
test("no run line for a language that has to be compiled first", () => {
  for (const languageId of ["c", "cpp", "java", "csharp", "typescript"]) {
    assert.equal(runLine(languageId, "x", "", false), undefined, languageId);
  }
});

test("no shebang, no interpreter", () => {
  assert.equal(interpreterOf("echo hi\n"), undefined);
  // A shebang has to be the first line; one further down is a comment.
  assert.equal(interpreterOf("echo hi\n#!/bin/bash\n"), undefined);
});
