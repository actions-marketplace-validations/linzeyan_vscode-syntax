import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { cacheDir, RefStore } from "./refStore";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "poly-refstore-"));
const everyFile = () => true;
const DAY = 86_400_000;

test("a count outlives the session that asked for it", () => {
  const dir = scratch();
  const first = new RefStore(dir, everyFile);
  first.set("/work/api", "main.go", "refs|12:Serve#0", 7);
  first.answer("/work/api", "go", "refs");
  first.save();

  const next = new RefStore(dir, everyFile);
  assert.equal(next.get("/work/api", "main.go", "refs|12:Serve#0"), 7);
  assert.deepEqual(next.answered("/work/api", "go"), ["refs"]);
  assert.equal(next.get("/work/other", "main.go", "refs|12:Serve#0"), undefined);
});

test("a file deleted while the window was closed takes its counts with it", () => {
  const dir = scratch();
  const first = new RefStore(dir, everyFile);
  first.set("/work/api", "kept.go", "refs|12:A#0", 1);
  first.set("/work/api", "gone.go", "refs|12:B#0", 2);
  first.save();

  const next = new RefStore(dir, (file) => !file.endsWith("gone.go"));
  assert.equal(next.get("/work/api", "gone.go", "refs|12:B#0"), undefined);
  next.save();
  const written = JSON.parse(fs.readFileSync(next.fileFor("/work/api"), "utf8"));
  assert.deepEqual(Object.keys(written.files), ["kept.go"]);
});

test("a declaration renamed away is forgotten when its file is counted again", () => {
  const store = new RefStore(scratch(), everyFile);
  store.set("/w", "a.ts", "refs|12:old#0", 3);
  store.set("/w", "a.ts", "refs|12:kept#0", 4);
  store.retain("/w", "a.ts", new Set(["refs|12:kept#0", "refs|12:new#0"]));
  assert.equal(store.get("/w", "a.ts", "refs|12:old#0"), undefined);
  assert.equal(store.get("/w", "a.ts", "refs|12:kept#0"), 4);
});

test("an unreadable file is an empty cache, not an error", () => {
  const dir = scratch();
  const store = new RefStore(dir, everyFile);
  fs.writeFileSync(store.fileFor("/w"), "{ not json");
  assert.equal(new RefStore(dir, everyFile).get("/w", "a.ts", "refs|12:x#0"), undefined);
});

test("two projects with the same folder name keep separate files", () => {
  const store = new RefStore(scratch(), everyFile);
  assert.notEqual(store.fileFor("/a/api"), store.fileFor("/b/api"));
  assert.match(path.basename(store.fileFor("/a/api")), /^api-[0-9a-f]{12}\.json$/);
});

test("a project unopened for a month loses its file, and opening one keeps it", () => {
  const dir = scratch();
  const first = new RefStore(dir, everyFile);
  first.set("/old", "a.ts", "refs|12:x#0", 1);
  first.set("/used", "a.ts", "refs|12:x#0", 1);
  first.save();
  const monthAgo = new Date(Date.now() - 31 * DAY);
  fs.utimesSync(first.fileFor("/old"), monthAgo, monthAgo);
  fs.utimesSync(first.fileFor("/used"), monthAgo, monthAgo);
  // Opened last session: loading it is what says it is in use.
  new RefStore(dir, everyFile, Date.now() - 31 * DAY).get("/used", "a.ts", "refs|12:x#0");

  new RefStore(dir, everyFile);
  assert.equal(fs.existsSync(first.fileFor("/old")), false);
  assert.equal(fs.existsSync(first.fileFor("/used")), true);
});

test("the cache is under XDG_CACHE_HOME, beside the daemon's tools", () => {
  assert.equal(cacheDir({ XDG_CACHE_HOME: "/x", HOME: "/h" }, "linux"), path.join("/x", "poly", "refs"));
  assert.equal(cacheDir({ XDG_CACHE_HOME: "", HOME: "/h" }, "darwin"), path.join("/h", ".cache", "poly", "refs"));
  assert.equal(cacheDir({ LOCALAPPDATA: "C:\\L" }, "win32"), path.join("C:\\L", "poly", "refs"));
});
