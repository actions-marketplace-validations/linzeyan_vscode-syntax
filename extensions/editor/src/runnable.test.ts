import * as assert from "node:assert/strict";
import { test } from "node:test";

import { entryPoints } from "./runnable";

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

test("a local named main inside a function is not the program's entry", () => {
  // Depth two is Java's class; depth three is somebody's closure.
  const file = [
    symbol("outer", FUNCTION, [symbol("helper", FUNCTION, [symbol("main", FUNCTION)])]),
  ];
  assert.deepEqual(entryPoints(file), []);
});
