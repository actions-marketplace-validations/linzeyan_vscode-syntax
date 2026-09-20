#!/usr/bin/env node
// Fetches VSCode's own colorize fixtures for grammar-diff to run over.
//
// These are the files microsoft/vscode tokenizes in its own tests, and most of
// them are named for the issue number of a highlighting bug somebody reported:
// 12750.html, 14119.less, test-freeze-56377.py. As edge cases they beat
// anything written here, because a grammar maintainer picked each one after it
// broke something.
//
// Not committed. They are someone else's test data, they change, and a copy in
// this repo would be a stale fork of it -- the same reason editor-diff installs
// the marketplace's current version rather than a pinned one. Cached in tmp so
// only the first run pays.
//
// Usage: node tools/colorize-corpus.mjs   # prints the directory
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(tmpdir(), "poly-colorize-corpus");
const LISTING = "https://api.github.com/repos/microsoft/vscode/contents/"
  + "extensions/vscode-colorize-tests/test/colorize-fixtures";

function curl(url, extra = []) {
  const auth = process.env.GITHUB_TOKEN
    ? ["-H", `Authorization: Bearer ${process.env.GITHUB_TOKEN}`]
    : [];
  return execFileSync("curl", ["-sSL", "-A", "poly-colorize-corpus", ...auth, ...extra, url]);
}

mkdirSync(DIR, { recursive: true });
// One listing request, then raw.githubusercontent for the contents, which does
// not count against the API rate limit -- so this works without a token.
if (readdirSync(DIR).length === 0) {
  const entries = JSON.parse(curl(LISTING).toString("utf8"));
  if (!Array.isArray(entries)) {
    console.error(`could not list the fixtures: ${entries.message ?? "unexpected response"}`);
    process.exit(2);
  }
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.download_url) continue;
    writeFileSync(join(DIR, entry.name), curl(entry.download_url));
  }
}
console.log(DIR);
console.error(`${readdirSync(DIR).length} colorize fixtures in ${DIR}`);
