import * as assert from "node:assert";
import { test } from "node:test";

import { enclosing, kindName, rowPrefix, TreeSymbol } from "./referenceRows";

/** A Go-shaped outline: a package-level func, and a type with a method. */
const OUTLINE: TreeSymbol[] = [
  { name: "Config", kind: 22, startLine: 3, endLine: 6 },
  {
    name: "Server",
    kind: 22,
    startLine: 8,
    endLine: 30,
    children: [
      { name: "Handle", kind: 5, startLine: 12, endLine: 20 },
      { name: "Close", kind: 5, startLine: 22, endLine: 26 },
    ],
  },
  { name: "main", kind: 11, startLine: 40, endLine: 50 },
];

test("a hit inside a method names the method, not the type it is on", () => {
  // The whole reason the walk goes deeper rather than stopping at the first
  // container: every row in this file is inside `Server`, so saying so tells
  // the reader nothing.
  assert.strictEqual(enclosing(OUTLINE, 15)?.name, "Handle");
  assert.strictEqual(enclosing(OUTLINE, 24)?.name, "Close");
});

test("a hit in the type but outside every method names the type", () => {
  assert.strictEqual(enclosing(OUTLINE, 9)?.name, "Server");
  assert.strictEqual(enclosing(OUTLINE, 5)?.name, "Config");
});

test("a hit inside nothing has no enclosing symbol", () => {
  // An import block, a package clause, a blank line between declarations.
  // `undefined` rather than the file, because a row reading `file` for these
  // would be inventing a level that is not in the outline.
  assert.strictEqual(enclosing(OUTLINE, 0), undefined);
  assert.strictEqual(enclosing(OUTLINE, 7), undefined);
  assert.strictEqual(enclosing(OUTLINE, 60), undefined);
});

test("no outline at all is not an error", () => {
  // The ordinary case for a language with no symbol provider installed, which
  // is most of them in most windows.
  assert.strictEqual(enclosing([], 5), undefined);
});

test("the boundary lines of a symbol are inside it", () => {
  // A declaration's own line is the commonest hit in any result set --
  // `executeReferenceProvider` includes it -- so an off-by-one here would put
  // the wrong kind on the row people look at first.
  assert.strictEqual(enclosing(OUTLINE, 8)?.name, "Server");
  assert.strictEqual(enclosing(OUTLINE, 30)?.name, "Server");
  assert.strictEqual(enclosing(OUTLINE, 12)?.name, "Handle");
  assert.strictEqual(enclosing(OUTLINE, 20)?.name, "Handle");
});

test("kinds are worded the way the user asked for them", () => {
  assert.strictEqual(kindName(11), "func");
  assert.strictEqual(kindName(12), "var");
  assert.strictEqual(kindName(3), "package");
  assert.strictEqual(kindName(22), "struct");
});

test("a kind outside the enum has no word rather than a wrong one", () => {
  // A server may send anything. An empty column says less than a number does,
  // which is the point: `27` is not information.
  assert.strictEqual(kindName(99), undefined);
  assert.strictEqual(kindName(-1), undefined);
});

test("the line number in a row is the one in the gutter", () => {
  // 1-based, while everything in the protocol around it counts from zero. This
  // is the number a `path:line` reference uses and the one a reader compares
  // against the editor.
  assert.strictEqual(rowPrefix(0, undefined).number, "1");
  assert.strictEqual(rowPrefix(14, undefined).number, "15");
});

test("a row names the symbol as well as its kind", () => {
  assert.strictEqual(rowPrefix(15, enclosing(OUTLINE, 15)).kind, "method Handle");
  assert.strictEqual(rowPrefix(45, enclosing(OUTLINE, 45)).kind, "func main");
});

test("a row inside nothing has an empty kind column", () => {
  assert.strictEqual(rowPrefix(0, undefined).kind, "");
  // Also when the symbol is there but its kind is not one this knows: the row
  // still gets its line number, which is the half that never depends on a
  // language server.
  const odd: TreeSymbol = { name: "x", kind: 99, startLine: 0, endLine: 1 };
  assert.deepStrictEqual(rowPrefix(0, odd), { number: "1", kind: "" });
});
