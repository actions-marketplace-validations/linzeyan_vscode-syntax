import * as assert from "node:assert";
import { test } from "node:test";

import { colorSheet, scopesIn } from "./scopes";

/** A grammar shaped like a real one: nested patterns, a repository, captures. */
const GRAMMAR = {
  name: "Solidity",
  scopeName: "source.solidity",
  patterns: [
    { include: "#comments" },
    {
      begin: "\\b(contract)\\s+([A-Z]\\w*)",
      beginCaptures: {
        "1": { name: "storage.type.contract.solidity" },
        "2": { name: "entity.name.type.contract.solidity" },
      },
      end: "\\}",
      patterns: [{ match: "\\b(public|private)\\b", name: "storage.modifier.solidity" }],
    },
  ],
  repository: {
    comments: {
      patterns: [
        {
          begin: "/\\*",
          end: "\\*/",
          name: "comment.block.solidity",
          contentName: "meta.embedded.comment.solidity",
        },
      ],
    },
  },
};

test("every scope in the grammar is on the sheet, however deep it sits", () => {
  // The three depths a real grammar uses: a top-level pattern's own captures, a
  // pattern nested inside a begin/end rule, and a rule reached through the
  // repository. Missing any of them makes the sheet a partial list, which is
  // worse than none -- a scope that is not on it looks like a scope that does
  // not exist.
  const scopes = scopesIn(GRAMMAR);
  assert.ok(scopes.includes("entity.name.type.contract.solidity"));
  assert.ok(scopes.includes("storage.modifier.solidity"));
  assert.ok(scopes.includes("comment.block.solidity"));
  assert.ok(scopes.includes("meta.embedded.comment.solidity"));
});

test("the root scope is on the sheet and the display name is not", () => {
  // `scopeName` is what a theme rule uses to say "everything in this language".
  // The grammar's own `name` is the word in the language picker, and a rule
  // targeting "Solidity" would match nothing at all.
  const scopes = scopesIn(GRAMMAR);
  assert.ok(scopes.includes("source.solidity"));
  assert.ok(!scopes.includes("Solidity"));
});

test("a templated scope is left off", () => {
  // `entity.name.tag.$2.html` is filled in from a capture group. What it
  // expands to cannot be known without tokenizing a file, and the literal text
  // matches nothing, so a rule written against it is a rule that never fires.
  const scopes = scopesIn({
    scopeName: "text.html.basic",
    patterns: [{ match: "<(\\w+)", name: "entity.name.tag.$1.html" }],
  });
  assert.deepStrictEqual(scopes, ["text.html.basic"]);
});

test("several scopes in one name are several scopes", () => {
  // TextMate allows a space-separated list, and a theme addresses each part.
  assert.deepStrictEqual(
    scopesIn({ patterns: [{ match: "x", name: "meta.tag.html entity.name.tag.html" }] }),
    ["entity.name.tag.html", "meta.tag.html"],
  );
});

test("the same scope named twice appears once, and the list is sorted", () => {
  assert.deepStrictEqual(
    scopesIn({
      patterns: [
        { match: "a", name: "keyword.control" },
        { match: "b", name: "comment.line" },
        { match: "c", name: "keyword.control" },
      ],
    }),
    ["comment.line", "keyword.control"],
  );
});

test("nothing recognisable is an empty sheet rather than a throw", () => {
  // A grammar poly did not sync could be any shape at all.
  assert.deepStrictEqual(scopesIn(null), []);
  assert.deepStrictEqual(scopesIn("not a grammar"), []);
  assert.deepStrictEqual(scopesIn({}), []);
});

test("the sheet's placeholder is not a colour", () => {
  // Pasted unedited, every rule is ignored. That is the failure mode worth
  // having: the alternative is a default that quietly recolours something.
  const sheet = colorSheet("solidity", "ricky.poly-syntax-highlight", [
    "comment.block.solidity",
  ]);
  assert.ok(sheet.includes(`"foreground": "#RRGGBB"`));
  assert.ok(!/#[0-9a-fA-F]{6}/.test(sheet));
});

test("the sheet is a settings fragment, not prose about one", () => {
  // It is meant to be copied from. A JSON parse of the body is the only way to
  // find out that the rules were written wrong, since nothing else reads it.
  const sheet = colorSheet("go", "ricky.poly-syntax-highlight", [
    "keyword.control.go",
    "string.quoted.double.go",
  ]);
  const body = sheet.split("\n").filter((line) => !line.startsWith("//")).join("\n");
  const parsed = JSON.parse(body);
  assert.deepStrictEqual(
    parsed["editor.tokenColorCustomizations"].textMateRules.map((
      rule: { scope: string },
    ) => rule.scope),
    ["keyword.control.go", "string.quoted.double.go"],
  );
});
