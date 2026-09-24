#!/usr/bin/env node
// Launches the editor differential: one extension host, poly loaded
// from source, and the extensions 08 §4 says it replaces installed beside it.
//
// The originals come from the marketplace at whatever version is current --
// pinning them would be pinning someone else's product, and the question this
// asks is "does poly still answer like the thing people actually have".
//
// Usage: node tools/editor-diff/run.js
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const { runTests } = require(join(ROOT, "extensions", "lsp", "node_modules", "@vscode", "test-electron"));
const { writeCorpus } = require("./corpus.js");

// publisher, name -- the replaced extensions whose answers are the reference.
const ORIGINALS = [
  ["yzhang", "markdown-all-in-one"],
  ["ezforo", "copy-relative-path-and-line-numbers"],
];

const SCRATCH = join(tmpdir(), "poly-editor-diff");

function install(publisher, name) {
  const vsix = join(SCRATCH, `${name}.vsix`);
  const extensions = join(SCRATCH, "extensions");
  const target = join(extensions, `${publisher}.${name}`);
  // The cache lives under TMPDIR, which macOS prunes by file age while leaving
  // the directories behind. An unpacked extension that has lost its manifest
  // and its bundle still passes an `existsSync` on the directory, and the host
  // then fails with `Cannot find module .../dist/node/main.js` -- which names
  // the extension but not the reason. Ask for the manifest instead, and start
  // that copy over when it is not there.
  if (existsSync(target) && !existsSync(join(target, "package.json"))) {
    rmSync(target, { recursive: true, force: true });
    rmSync(vsix, { force: true });
  }
  if (!existsSync(vsix)) {
    const url = "https://marketplace.visualstudio.com/_apis/public/gallery/"
      + `publishers/${publisher}/vsextensions/${name}/latest/vspackage`;
    // curl rather than fetch(): the gallery answers with gzip regardless, and
    // --compressed is one flag against a stream to decode by hand.
    execFileSync("curl", ["-sSL", "--compressed", "-A", "poly-editor-diff", "-o", vsix, url]);
  }
  if (!existsSync(target)) {
    const staging = mkdtempSync(join(SCRATCH, "unzip-"));
    execFileSync("unzip", ["-q", vsix, "extension/*", "-d", staging]);
    mkdirSync(extensions, { recursive: true });
    execFileSync("mv", [join(staging, "extension"), target]);
    rmSync(staging, { recursive: true, force: true });
    // VSCode reads `extensions.json` as the list of what is installed rather
    // than scanning the directory, so a folder unpacked beside an existing
    // cache is not seen at all -- it gets written into `.obsolete` instead,
    // and the run then fails claiming the extension is not installed. Dropping
    // both makes the next launch rescan. Only on a fresh unpack, so the usual
    // case still starts from the cache.
    for (const stale of ["extensions.json", ".obsolete"]) {
      rmSync(join(extensions, stale), { force: true });
    }
  }
  return target;
}

async function main() {
  // A VSCode integrated terminal exports its own bootstrap variables and the
  // test instance inherits them; same reason as extensions/lsp/src/test.
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) delete process.env[key];
  }

  mkdirSync(SCRATCH, { recursive: true });
  for (const [publisher, name] of ORIGINALS) {
    console.log(`installed ${install(publisher, name)}`);
  }

  // poly is loaded from source, so its bundle has to exist first.
  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });

  // The extension host has no network, so the upstream test corpus is fetched
  // and parsed out here and handed over as a file.
  const corpus = join(SCRATCH, "maio-corpus.json");
  console.log(
    `${writeCorpus(join(SCRATCH, "maio-tests"), corpus)} cases from ${"yzhang-gh/vscode-markdown"}'s own tests`,
  );

  const workspace = mkdtempSync(join(tmpdir(), "poly-editor-diff-ws-"));
  const cache = join(ROOT, "extensions", "lsp", ".vscode-test");
  const cached = existsSync(cache)
    ? readdirSync(cache)
      .filter((d) => d.startsWith("vscode-"))
      .sort()
      .pop()
    : null;
  let cachedExecutable = null;
  if (cached) {
    const macos = join(cache, cached, "Visual Studio Code.app", "Contents", "MacOS");
    if (existsSync(macos)) cachedExecutable = join(macos, readdirSync(macos)[0]);
  }

  await runTests({
    extensionDevelopmentPath: LSP,
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: {
      POLY_DIFF_OUT: join(ROOT, ".logs", "audit", "editor-diff.json"),
      POLY_DIFF_CORPUS: corpus,
    },
    // A stable download names the binary `Code`; an Insiders or Electron build
    // names it something else, so read the directory rather than guessing.
    ...(cachedExecutable ? { vscodeExecutablePath: cachedExecutable } : {}),
    launchArgs: [
      `--folder-uri=${pathToFileURL(workspace).toString()}`,
      `--extensions-dir=${join(SCRATCH, "extensions")}`,
      `--user-data-dir=${join(SCRATCH, "user-data")}`,
    ],
  });
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
