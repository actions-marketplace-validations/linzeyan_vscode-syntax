#!/usr/bin/env node
// Stages a sample of real source files for grammar-diff to run over.
//
// The three corpora already in use are all written to be interesting:
// `fixtures/` is one representative file per language, `fixtures/edge/` is
// constructs that only matter when two grammars are compared, and VSCode's
// colorize fixtures are files that broke a grammar badly enough for someone to
// file an issue. What none of them contain is an ordinary file -- thousands of
// lines of somebody's actual code, with the mix of constructs that only shows
// up at that length.
//
// Not committed, and not fetched either: it points at a tree already on the
// machine. Which tree is the argument, so this is about the shape of the
// sample, not about one directory.
//
// Sampling is deterministic and spread rather than taken from the front: files
// sort by path, so the first N of an extension are all from whichever directory
// sorts first, which is one project's house style rather than a language.
//
// Usage: node tools/real-corpus.mjs [tree] [--per N] [--max-kb N]
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";

const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const TREE = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : join(homedir(), "git", "resources");
const PER = flag("--per", 40);
const MAX = flag("--max-kb", 256) * 1024;
const DIR = join(tmpdir(), "poly-real-corpus");

// The extensions poly ships a grammar for and VSCode ships a built-in for, so
// the two sides have something to disagree about. Anything else in the tree is
// a file grammar-diff would skip after it had been copied.
const WANTED = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".md",
  ".py",
  ".json",
  ".jsonl",
  ".css",
  ".html",
  ".yaml",
  ".yml",
  ".sh",
  ".sql",
  ".rs",
  ".go",
  ".toml",
  ".swift",
  ".kt",
  ".cpp",
  ".h",
  ".m",
  ".xml",
  ".plist",
]);

/** Every wanted file under `tree`, by extension, in path order. */
function walk(tree) {
  const found = new Map();
  const stack = [tree];
  while (stack.length > 0) {
    const at = stack.pop();
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(at, entry.name);
      // `.git` holds packed objects, not source, and node_modules holds
      // somebody else's code twice over.
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && entry.name !== "node_modules") {
          stack.push(path);
        }
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (!WANTED.has(extension) || statSync(path).size > MAX) {
        continue;
      }
      found.set(extension, [...(found.get(extension) ?? []), path]);
    }
  }
  return found;
}

const found = walk(TREE);
if (found.size === 0) {
  console.error(`no source files under ${TREE}: nothing to compare`);
  process.exit(2);
}

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
let taken = 0;
for (const [extension, paths] of [...found].sort()) {
  // Every `step`-th file rather than the first N: the front of the list is one
  // directory, and one directory is one author's habits.
  const step = Math.max(1, Math.floor(paths.length / PER));
  for (let i = 0, n = 0; i < paths.length && n < PER; i += step, n++) {
    copyFileSync(paths[i], join(DIR, `${extension.slice(1)}-${String(n).padStart(3, "0")}${extension}`));
    taken++;
  }
}
console.error(`${taken} files from ${found.size} extensions under ${TREE}`);
console.log(DIR);
