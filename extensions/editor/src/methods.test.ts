import * as assert from "node:assert/strict";
import { test } from "node:test";

import { methodLabel, methodsOf, receiverOf } from "./methods";

const METHOD = 5;
const FUNCTION = 11;
const STRUCT = 22;

const symbol = (name: string, kind: number) => ({ name, kind });

test("gopls names a method after its receiver", () => {
  // Verbatim from gopls 0.23, both receiver forms.
  assert.equal(receiverOf("(Circle).Area"), "Circle");
  assert.equal(receiverOf("(*Circle).Save"), "Circle");
  // A generic type is reported with its parameters in the receiver and without
  // them in the declaration, so the two only meet once the brackets are gone.
  assert.equal(receiverOf("(Tree[T]).Insert"), "Tree");
});

test("buf names an rpc after the service it is in", () => {
  // `buf lsp serve` reports a service's rpcs beside it rather than inside it,
  // fully qualified -- so the same lens works on a .proto without buf having
  // to nest anything.
  assert.equal(receiverOf("greet.v1.Greeter.SayHello"), "greet.v1.Greeter");
});

test("an unqualified name belongs to nothing", () => {
  assert.equal(receiverOf("Describe"), undefined);
  assert.equal(receiverOf("Circle"), undefined);
  // Not a method declaration: a name that merely opens a paren is not one, and
  // the regex should not claim it if a server invents it.
  assert.equal(receiverOf("(unclosed.Area"), undefined);
});

test("a type's methods are its siblings, not its children", () => {
  const file = [
    symbol("Circle", STRUCT),
    symbol("(Circle).Area", METHOD),
    symbol("(*Circle).Scale", METHOD),
    symbol("Square", STRUCT),
    symbol("(Square).Area", METHOD),
    symbol("Describe", FUNCTION),
  ];
  assert.deepEqual(methodsOf("Circle", file).map((s) => s.name), [
    "(Circle).Area",
    "(*Circle).Scale",
  ]);
  assert.deepEqual(methodsOf("Square", file).map((s) => s.name), ["(Square).Area"]);
});

test("a type whose methods are inside it gets no count", () => {
  // TypeScript, Java and Python all nest a method under its class, where it is
  // already on screen. Counting furniture is the noise this avoids.
  const file = [symbol("Circle", STRUCT), symbol("area", METHOD)];
  assert.deepEqual(methodsOf("Circle", file), []);
});

test("a function is not a method however it is named", () => {
  const file = [symbol("(Circle).Area", FUNCTION)];
  assert.deepEqual(methodsOf("Circle", file), []);
});

test("the label says what the number means", () => {
  assert.equal(methodLabel(1), "1 method");
  assert.equal(methodLabel(4), "4 methods");
});
