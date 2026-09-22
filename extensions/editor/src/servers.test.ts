import * as assert from "node:assert";
import { test } from "node:test";

import { offerMessage, SERVERS, serverToOffer } from "./servers";

test("offers the server poly would run for the language", () => {
  assert.strictEqual(serverToOffer("protobuf", new Set()), "buf");
  assert.strictEqual(serverToOffer("shellscript", new Set()), "bash-language-server");
  // C and C++ are one server, and both have to reach it.
  assert.strictEqual(serverToOffer("c", new Set()), "clangd");
  assert.strictEqual(serverToOffer("cpp", new Set()), "clangd");
});

// The whole point of the offer is that poly could do something about it. A
// language poly runs no server for would be an offer to turn on a setting that
// changes nothing, which is the same defect one layer up.
test("says nothing for a language poly runs no server for", () => {
  for (const languageId of ["typescript", "python", "json", "markdown", "css"]) {
    assert.strictEqual(serverToOffer(languageId, new Set()), undefined, languageId);
  }
});

// Per language rather than per file: a workspace of forty .proto files is one
// question, and asking it forty times is how a helpful prompt becomes the
// reason someone uninstalls.
test("asks once per language, however many files", () => {
  assert.strictEqual(serverToOffer("protobuf", new Set(["protobuf"])), undefined);
  assert.strictEqual(serverToOffer("protobuf", new Set(["shellscript"])), "buf");
});

test("the message names the observation, the server and the reload", () => {
  const said = offerMessage("references", "shellscript", "bash-language-server");
  assert.match(said, /nothing answers references for shellscript/);
  assert.match(said, /bash-language-server/);
  assert.match(said, /poly\.languageServers/);
  assert.match(said, /reload/);
});

test("every server in the map is one poly.languageServers actually runs", () => {
  // The nine named in the poly.languageServers description, and arity for R.
  assert.deepStrictEqual([...new Set(SERVERS.values())].sort(), [
    "arity",
    "bash-language-server",
    "buf",
    "clangd",
    "gopls",
    "lua-language-server",
    "rust-analyzer",
    "sourcekit-lsp",
    "terraform-ls",
  ]);
});
