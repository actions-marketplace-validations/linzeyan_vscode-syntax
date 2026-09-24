import * as assert from "node:assert/strict";
import { test } from "node:test";

import { isMermaidContainer, isMermaidFence, MERMAID_CLASS, mermaidBlock } from "./mermaid";

test("the info string names mermaid, in any case and with anything after it", () => {
  assert.equal(isMermaidFence("mermaid"), true);
  assert.equal(isMermaidFence("  mermaid  "), true);
  assert.equal(isMermaidFence("Mermaid"), true);
  assert.equal(isMermaidFence("mermaid {caption=\"flow\"}"), true);
});

test("the boundary is a word boundary, the same one the built-in draws", () => {
  // Measured from `mermaid-markdown-features`' bundle in 1.138: it matches with
  // `\b(mermaid)\b`, so a hyphen is a boundary and `mermaid-example` renders.
  // poly agrees on purpose -- a fence that draws on 1.135 and not on 1.120 is
  // the failure this feature exists to avoid.
  assert.equal(isMermaidFence("mermaid-example"), true);
  assert.equal(isMermaidFence("mermaidjs"), false);
  assert.equal(isMermaidFence("rust"), false);
  assert.equal(isMermaidFence(""), false);
});

test("a container names mermaid as its first word, exactly", () => {
  // Stricter than the fence on purpose: the built-in's container rule compares
  // the first word for equality while its fence rule uses a word boundary, and
  // both are copied so a document renders the same on either side of 1.135.
  assert.equal(isMermaidContainer("mermaid"), true);
  assert.equal(isMermaidContainer(" mermaid "), true);
  assert.equal(isMermaidContainer("MERMAID"), true);
  assert.equal(isMermaidContainer("mermaid extra words"), true);
  assert.equal(isMermaidContainer("mermaid-example"), false);
  assert.equal(isMermaidContainer("note"), false);
  assert.equal(isMermaidContainer(""), false);
});

test("the source goes in as text, so a diagram cannot write HTML", () => {
  const html = mermaidBlock("graph TD\n  A[\"<script>alert(1)</script>\"] --> B\n");
  assert.equal(html.includes("<script>"), false);
  assert.equal(
    html,
    `<pre class="${MERMAID_CLASS}">graph TD\n  A[&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;] --&gt; B\n</pre>`,
  );
});

test("an ampersand is escaped once, not twice", () => {
  // `&` before `<` in the replacement order is the classic double-escape bug:
  // it turns `&lt;` into `&amp;lt;` and the diagram then draws the entity.
  assert.equal(mermaidBlock("A & B"), `<pre class="${MERMAID_CLASS}">A &amp; B</pre>`);
});
