// Editor-side E2E (M3 backlog). tools/lsp-smoke.py already proves the daemon
// speaks the protocol; what it cannot prove is that VSCode actually routes a
// document to it — activation events, the client's documentSelector and the
// contributed commands all live outside the protocol, and both times we broke
// them the protocol tests stayed green.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

/// A VSCode integrated terminal exports its own bootstrap variables, and the
/// test instance inherits them: `VSCODE_ESM_ENTRYPOINT` makes the fresh copy
/// boot as an extension host and `ELECTRON_RUN_AS_NODE` makes it boot as plain
/// node, both of which fail with an unrelated-looking "bad option" dump. Which
/// terminal you happen to run the tests from should not decide whether they
/// work.
function stripHostEnvironment(): void {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) {
      delete process.env[key];
    }
  }
}

/// Where this checkout's editor state goes, kept short on purpose.
///
/// VSCode puts its IPC socket inside the user-data directory, and a unix
/// socket path cannot exceed 103 characters. The default sits under the
/// checkout — extensions/lsp/.vscode-test/user-data — which fits for a clone in
/// ~/git and does not for a worktree a few directories below one, so `make e2e`
/// only ran where the checkout happened to be shallow enough, and failed
/// elsewhere with an ENAMETOOLONG that named neither the limit nor the path.
/// `/tmp` rather than os.tmpdir() because macOS's is a 48-character per-user
/// path: half the budget spent before the name.
///
/// Keyed by the checkout rather than by the run, so that two worktrees can
/// test at once — a shared user-data directory means the second editor to
/// start finds the first one's state — and so that repeated runs reuse it.
function userDataDir(repo: string): string {
  const key = createHash("sha1").update(repo).digest("hex").slice(0, 8);
  const root = process.platform === "win32" ? tmpdir() : "/tmp";
  return join(root, `poly-e2e-${key}`, "user-data");
}

/// The suite's own cache and config directories, with the real cache's
/// downloaded tools in it.
///
/// The reference lens keeps its counts per workspace under the cache, and each
/// run here opens a fresh temporary workspace nobody opens again: 77 of the 86
/// files in one developer's real cache were this suite's. Tools are linked, not
/// copied, because an empty tools directory is a download per run. The config
/// directory is empty so the daemon neither reads a developer's global
/// poly.toml nor writes one into their home. Not on Windows, where both are
/// LOCALAPPDATA/APPDATA and CI's runner is thrown away.
function cacheHome(): Record<string, string> {
  if (process.platform === "win32") {
    return {};
  }
  const tools = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "poly", "tools");
  const home = mkdtempSync(join(tmpdir(), "poly-e2e-cache-"));
  mkdirSync(tools, { recursive: true });
  mkdirSync(join(home, "poly"));
  symlinkSync(tools, join(home, "poly", "tools"));
  return { XDG_CACHE_HOME: home, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "poly-e2e-config-")) };
}

/// `runTests` on a folder the editor does not trust.
///
/// `runTests` puts `--disable-workspace-trust` on every launch and has no
/// option to leave it off, so this starts the editor itself, with the
/// arguments `runTests` would give it but that one.
async function runUntrusted(
  folder: string,
  userData: string,
  extensionDevelopmentPath: string,
  extensionTestsPath: string,
  env: Record<string, string>,
): Promise<void> {
  const executable = await downloadAndUnzipVSCode();
  const args = [
    `--folder-uri=${pathToFileURL(folder).toString()}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${resolve(".vscode-test", "extensions")}`,
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--no-cached-data",
    `--extensionTestsPath=${extensionTestsPath}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
  ];
  const code = await new Promise<number | null>((done, fail) => {
    const editor = spawn(executable, args, { env: { ...process.env, ...env }, stdio: "inherit" });
    editor.on("error", fail);
    editor.on("exit", done);
  });
  if (code !== 0) {
    throw new Error(`the Restricted Mode run exited with ${code}`);
  }
}

async function main(): Promise<void> {
  stripHostEnvironment();
  const cache = cacheHome();
  // Compiled to out/test/runTest.js, so two levels up is the extension root.
  const extensionDevelopmentPath = resolve(__dirname, "..", "..");
  const extensionTestsPath = resolve(__dirname, "suite", "index");
  const repo = resolve(extensionDevelopmentPath, "..", "..");
  const serverPath = process.env.POLY_BIN
    ?? join(repo, "cli", "target", "release", "poly");

  // A throwaway workspace rather than the repo: the tests write files and run
  // batch formatting, and pointing those at the checkout would rewrite it.
  const workspace = mkdtempSync(join(tmpdir(), "poly-e2e-"));
  mkdirSync(join(workspace, ".vscode"));
  writeFileSync(
    join(workspace, ".vscode", "settings.json"),
    JSON.stringify(
      {
        poly: {
          serverPath,
          // Would pop modal-ish UI that nothing in a headless run dismisses.
          updateCheck: { enabled: false },
          // Every poly feature that is not formatting or linting ships off, so
          // a suite that exercises one has to say so. Inheriting the
          // default would turn the dead-code lens tests into a 45-second wait
          // for a lens nobody asked for, reported as a timeout.
          deadCodeCodeLens: { enabled: true },
        },
      },
      null,
      2,
    ),
  );
  // gopls refuses to resolve anything outside a module, so the throwaway
  // workspace needs to be one before it can answer a single question.
  writeFileSync(join(workspace, "go.mod"), "module polye2e\n\ngo 1.21\n");
  // Its own, so that the log test finds this run's files and no other's.
  const logs = mkdtempSync(join(tmpdir(), "poly-e2e-logs-"));
  // The suite waits for activation to write the poly block before it touches
  // the user's settings.json. The last run's block, which its tests rewrote
  // without comments, would end that wait at once and race the rewrite.
  rmSync(join(userDataDir(repo), "User", "settings.json"), { force: true });

  await runTests({
    // The second one ships only a language default; see its description.
    extensionDevelopmentPath: [
      extensionDevelopmentPath,
      resolve(extensionDevelopmentPath, "src", "test", "fixture-defaults"),
    ],
    extensionTestsPath,
    // --folder-uri, not a bare path: launchArgs are prepended, and Electron
    // reads a leading positional as the app to run rather than as a workspace.
    // Built-in extensions stay on — they own the `sql` and `python` language
    // ids the tests rely on.
    launchArgs: [
      `--folder-uri=${pathToFileURL(workspace).toString()}`,
      `--user-data-dir=${userDataDir(repo)}`,
      `--logsPath=${logs}`,
    ],
    extensionTestsEnv: { ...cache, POLY_E2E_LOGS: logs },
  });

  // Code Runner stands aside while formulahendry.code-runner is installed,
  // which only shows with it installed -- and every test above has to run
  // without it. So a second editor, beside a stand-in with its id, runs the
  // one suite about that (see suite/index.ts).
  const beside = mkdtempSync(join(tmpdir(), "poly-e2e-"));
  mkdirSync(join(beside, ".vscode"));
  writeFileSync(
    join(beside, ".vscode", "settings.json"),
    JSON.stringify(
      {
        poly: {
          serverPath,
          updateCheck: { enabled: false },
          // On, so that standing aside is the only thing left to stop Run Code.
          codeRunner: { enabled: true },
          runCodeLens: { enabled: true },
        },
      },
      null,
      2,
    ),
  );
  await runTests({
    extensionDevelopmentPath: [
      extensionDevelopmentPath,
      resolve(extensionDevelopmentPath, "src", "test", "fixture-code-runner"),
    ],
    extensionTestsPath,
    launchArgs: [
      `--folder-uri=${pathToFileURL(beside).toString()}`,
      `--user-data-dir=${userDataDir(repo)}`,
    ],
    extensionTestsEnv: { ...cache, POLY_E2E_SUITE: "code-runner-yield" },
  });

  // Git History reads with poly where there is no git, which every other run
  // here has. With vscode.git disabled the panel sees what a machine without
  // git shows it, while the test itself can still use git to build a repository.
  const gitless = mkdtempSync(join(tmpdir(), "poly-e2e-"));
  mkdirSync(join(gitless, ".vscode"));
  writeFileSync(
    join(gitless, ".vscode", "settings.json"),
    JSON.stringify({ poly: { serverPath, updateCheck: { enabled: false } } }, null, 2),
  );
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      `--folder-uri=${pathToFileURL(gitless).toString()}`,
      `--user-data-dir=${userDataDir(repo)}`,
      "--disable-extension=vscode.git",
    ],
    extensionTestsEnv: { ...cache, POLY_E2E_SUITE: "no-git" },
  });

  // Restricted Mode. The folder's own settings name a poly that does not
  // exist, so a daemon starts only if they are ignored, and it brings a
  // prettier poly would take over markdown with, which leaves a mark if run.
  const untrusted = mkdtempSync(join(tmpdir(), "poly-e2e-"));
  mkdirSync(join(untrusted, ".vscode"));
  writeFileSync(
    join(untrusted, ".vscode", "settings.json"),
    JSON.stringify({ poly: { serverPath: join(untrusted, "no-such-poly") } }, null, 2),
  );
  const ran = join(untrusted, "prettier.ran");
  const bin = join(untrusted, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  // It reads what poly sends and answers with its own text, so a run of it is
  // a formatting result the test can name rather than a formatter that hung.
  if (process.platform === "win32") {
    writeFileSync(
      join(bin, "prettier.cmd"),
      `@echo off\r\nmore > nul\r\necho ran> "${ran}"\r\necho the folder's prettier ran\r\n`,
    );
  } else {
    writeFileSync(
      join(bin, "prettier"),
      `#!/bin/sh\ncat > /dev/null\necho ran > '${ran}'\necho "the folder's prettier ran"\n`,
    );
    chmodSync(join(bin, "prettier"), 0o755);
  }
  writeFileSync(join(untrusted, ".prettierrc"), "{}\n");
  // A profile of its own: the trust setting below stays out of the launches
  // above, and their poly block out of this one.
  const restricted = join(dirname(userDataDir(repo)), "untrusted");
  mkdirSync(join(restricted, "User"), { recursive: true });
  writeFileSync(
    join(restricted, "User", "settings.json"),
    JSON.stringify(
      {
        // Restricted Mode without the dialog asking whether to leave it.
        "security.workspace.trust.startupPrompt": "never",
        poly: { serverPath, updateCheck: { enabled: false }, codeRunner: { enabled: true } },
      },
      null,
      2,
    ),
  );
  await runUntrusted(untrusted, restricted, extensionDevelopmentPath, extensionTestsPath, {
    ...cache,
    POLY_E2E_SUITE: "restricted",
    POLY_E2E_PRETTIER_RAN: ran,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
