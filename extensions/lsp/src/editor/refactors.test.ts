import * as assert from "node:assert/strict";
import { test } from "node:test";

import { refactorChoices, REFACTORINGS } from "./refactors";

const action = (title: string, kind?: string) => ({ title, kind });

test("a command named after a variable does not offer to extract a function", () => {
  // gopls, verbatim: both are refactor.extract and only one of them is what
  // Extract Variable promised.
  const offered = [
    action("Extract function", "refactor.extract"),
    action("Extract variable", "refactor.extract"),
    action("Extract method", "refactor.extract"),
  ];
  assert.deepEqual(refactorChoices(offered, "extractVariable"), [
    action("Extract variable", "refactor.extract"),
  ]);
});

test("a sub-kind counts as its parent kind", () => {
  // TypeScript tags its own, and the title says "constant" rather than
  // "variable" because that is the only word it has for a local binding.
  const offered = [
    action("Extract to function in module scope", "refactor.extract.function"),
    action("Extract to constant in enclosing scope", "refactor.extract.constant"),
  ];
  assert.deepEqual(refactorChoices(offered, "extractVariable"), [
    action("Extract to constant in enclosing scope", "refactor.extract.constant"),
  ]);
});

test("wording nobody has measured costs a menu, not the feature", () => {
  // The fallback matters more than the filter: a server this file has never
  // seen still has to be usable, and the user can read three titles.
  const offered = [
    action("Introduce binding", "refactor.extract"),
    action("Hoist subexpression", "refactor.extract"),
  ];
  assert.deepEqual(refactorChoices(offered, "extractVariable"), offered);
});

test("inline and extract do not see each other's actions", () => {
  const offered = [
    action("Inline variable", "refactor.inline"),
    action("Extract into variable", "refactor.extract"),
  ];
  assert.deepEqual(refactorChoices(offered, "inlineVariable"), [
    action("Inline variable", "refactor.inline"),
  ]);
  assert.deepEqual(refactorChoices(offered, "extractVariable"), [
    action("Extract into variable", "refactor.extract"),
  ]);
});

test("a quick fix that arrived uninvited is not a refactoring", () => {
  // Providers are allowed to answer with more than they were asked for, and an
  // organize-imports action applied by Extract Variable would be a surprise
  // the user has no way to connect to what they pressed.
  const offered = [
    action("Organize imports", "source.organizeImports"),
    action("Add missing import", "quickfix"),
    action("Refactor everything", "refactorial"),
    action("Unclassified"),
  ];
  assert.deepEqual(refactorChoices(offered, "extractVariable"), []);
});

test("the kinds asked for are the ones the protocol names", () => {
  assert.equal(REFACTORINGS.extractVariable.kind, "refactor.extract");
  assert.equal(REFACTORINGS.inlineVariable.kind, "refactor.inline");
  // Not `refactor.move`: gopls answers null for that kind and files the same
  // gesture under `refactor.extract.toNewFile` (measured 2026-09-21).
  assert.equal(REFACTORINGS.moveToNewFile.kind, "refactor.extract");
  assert.equal(REFACTORINGS.changeSignature.kind, "refactor.rewrite");
  assert.equal(REFACTORINGS.implementInterface.kind, "quickfix");
});

test("Move to New File and Extract Variable share a kind and not an answer", () => {
  // The whole reason the meaning filter exists: both commands ask for
  // `refactor.extract`, and picking by kind alone would make each of them run
  // the other's refactoring.
  const offered = [
    action("Extract variable", "refactor.extract"),
    action("Extract declarations to new file", "refactor.extract.toNewFile"),
  ];
  assert.deepEqual(refactorChoices(offered, "moveToNewFile"), [
    action("Extract declarations to new file", "refactor.extract.toNewFile"),
  ]);
  assert.deepEqual(refactorChoices(offered, "extractVariable"), [
    action("Extract variable", "refactor.extract"),
  ]);
});

test("Change Signature offers the parameter rewrites and nothing else", () => {
  // gopls, verbatim at a parameter. `refactor.rewrite` is where it also files
  // fillStruct and invertIf, which have nothing to do with a signature.
  const offered = [
    action("Move parameter left", "refactor.rewrite.moveParamLeft"),
    action("Split parameters into separate lines", "refactor.rewrite.splitLines"),
    action("Remove unused parameter", "refactor.rewrite.removeUnusedParam"),
    action("Fill Triangle", "refactor.rewrite.fillStruct"),
    action("Invert if condition", "refactor.rewrite.invertIf"),
  ];
  assert.deepEqual(refactorChoices(offered, "changeSignature"), [
    action("Move parameter left", "refactor.rewrite.moveParamLeft"),
    action("Split parameters into separate lines", "refactor.rewrite.splitLines"),
    action("Remove unused parameter", "refactor.rewrite.removeUnusedParam"),
  ]);
});

test("Implement Interface has no fallback, because quickfix holds everything", () => {
  // The other four commands ask for a kind that is already the refactoring, so
  // an unmeasured wording costs a menu. This one asks for the bucket every
  // server drops every fix into: offering "Add missing import" under Implement
  // Interface would apply an edit the user never asked for.
  const stubs = [
    action("Declare missing methods of Shape", "quickfix"),
    action("Implement missing members", "quickfix"),
    action("Add unimplemented methods", "quickfix"),
    action("Implement interface 'Shape'", "quickfix"),
  ];
  assert.deepEqual(refactorChoices(stubs, "implementInterface"), stubs);
  assert.deepEqual(
    refactorChoices([action("Add missing import", "quickfix")], "implementInterface"),
    [],
  );
});
