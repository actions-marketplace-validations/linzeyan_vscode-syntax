import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { commitDetails, comparison, gitIn, loadGraph, uncommittedChanges } from "./gitGraphData";
import { DEFAULT_VIEW, UNCOMMITTED } from "./gitGraphProtocol";

// One repository for every test: four commits, each touching a known set of
// paths, then a working tree with one change inside `src` and one outside.
const repo = mkdtempSync(join(tmpdir(), "poly-git-scope-"));
after(() => {
  // git writes its objects read-only, and on Windows rmSync refuses to delete a
  // read-only file.
  for (const entry of readdirSync(repo, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) chmodSync(join(entry.parentPath, entry.name), 0o666);
  }
  rmSync(repo, { recursive: true, force: true });
});

let clock = 1_700_000_000;
const git = (...args: string[]) =>
  execFileSync("git", [
    "-c",
    "user.name=Ada",
    "-c",
    "user.email=ada@example.com",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ], {
    cwd: repo,
    encoding: "utf8",
    // Distinct dates, so date order is the order they were made in.
    env: { ...process.env, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock++} +0000` },
  }).trim();
const write = (file: string, text: string) => writeFileSync(join(repo, file), text);
const commit = (message: string, ...files: [string, string][]) => {
  for (const [file, text] of files) write(file, text);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

git("init", "-q", "-b", "main");
mkdirSync(join(repo, "src"));
mkdirSync(join(repo, "docs"));
const first = commit("First", ["src/a.txt", "1\n"], ["docs/x.md", "1\n"]);
const second = commit("Docs only", ["docs/x.md", "2\n"]);
const third = commit("Both", ["src/a.txt", "3\n"], ["docs/x.md", "3\n"]);
const fourth = commit("Docs again", ["docs/x.md", "4\n"]);
write("src/a.txt", "working\n");
write("docs/new.md", "untracked\n");

const run = gitIn("git", repo);

test("a folder's history lists only the commits that changed something in it", async () => {
  const graph = await loadGraph(run, DEFAULT_VIEW, 100, "src");
  const listed = graph.commits.filter((c) => c.hash !== UNCOMMITTED).map((c) => c.subject);
  assert.deepEqual(listed, ["Both", "First"]);
});

test("a narrowed list still draws as one line", async () => {
  // `Both`'s real parent is `Docs only`, which is not listed. Its parent as
  // listed has to be `First`, or the graph has nothing to connect it to and
  // every row becomes a separate dot.
  const graph = await loadGraph(run, DEFAULT_VIEW, 100, "src");
  const both = graph.commits.find((c) => c.hash === third)!;
  assert.deepEqual(both.parents, [first]);
});

test("uncommitted changes count only the path's, on the last commit that touched it", async () => {
  // HEAD (`Docs again`) is not in a history of `src`; hanging the row on it
  // would leave the row with no line into the graph.
  const graph = await loadGraph(run, DEFAULT_VIEW, 100, "src");
  const row = graph.commits[0];
  assert.equal(row.hash, UNCOMMITTED);
  assert.equal(row.subject, "Uncommitted Changes (1)", "docs/new.md is not in src");
  assert.deepEqual(row.parents, [third]);
  // Nothing uncommitted in this file: no row at all.
  const file = await loadGraph(run, DEFAULT_VIEW, 100, "docs/x.md");
  assert.notEqual(file.commits[0].hash, UNCOMMITTED);
  assert.deepEqual(file.commits.map((c) => c.hash), [fourth, third, second, first]);
});

test("a commit's files, in a narrowed history, are only the path's", async () => {
  // The rest of the commit is a different question; the one asked is what
  // happened to this path.
  const details = await commitDetails(run, third, "src");
  assert.deepEqual(details.files.map((f) => f.newPath), ["src/a.txt"]);
  const whole = await commitDetails(run, third);
  assert.deepEqual(whole.files.map((f) => f.newPath).sort(), ["docs/x.md", "src/a.txt"]);
  assert.deepEqual((await uncommittedChanges(run, "src")).map((f) => f.newPath), ["src/a.txt"]);
  assert.deepEqual((await comparison(run, first, fourth, "src")).map((f) => f.newPath), ["src/a.txt"]);
});

test("stashes stay out of a narrowed history", async () => {
  // A stash hangs off the commit it was made on, which a narrowed list need
  // not hold.
  git("stash", "push", "-q", "--", "src/a.txt");
  try {
    const graph = await loadGraph(run, DEFAULT_VIEW, 100, "src");
    assert.equal(graph.commits.some((c) => c.stash), false);
    const whole = await loadGraph(run, DEFAULT_VIEW, 100);
    assert.equal(whole.commits.some((c) => c.stash), true);
  } finally {
    git("stash", "pop", "-q");
  }
});
