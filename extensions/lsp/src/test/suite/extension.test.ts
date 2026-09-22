import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as vscode from "vscode";

import { commonRoot, useLines } from "../../gowork";

const EXTENSION_ID = "ricky.poly-lsp";

const COMMANDS = [
  "poly.formatFile",
  "poly.formatPath",
  "poly.formatWorkspace",
  "poly.formatGitRepo",
  "poly.formatGitChanged",
  "poly.lintPath",
  "poly.analyzeDeadCode",
  "poly.checkForUpdates",
  "poly.showOutput",
  "poly.createGoWork",
];

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the test host opened no workspace folder");
  return folder.uri.fsPath;
}

function writeFile(name: string, content: string): vscode.Uri {
  const file = join(workspaceRoot(), name);
  writeFileSync(file, content);
  return vscode.Uri.file(file);
}

/// Diagnostics and formatter registration both arrive asynchronously after the
/// client connects; poll rather than sleeping a guessed interval.
async function eventually<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

/// Format through the editor and return the resulting text. Asserting on the
/// raw edits would be brittle: VSCode minimizes a whole-document replacement
/// into a handful of one-character splices before handing it back.
async function formatted(uri: vscode.Uri): Promise<string> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const edits = await eventually(
    `a formatter for ${document.languageId}`,
    async () => {
      const found = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        "vscode.executeFormatDocumentProvider",
        uri,
        { tabSize: 2, insertSpaces: true },
      );
      return found && found.length > 0 ? found : undefined;
    },
  );
  const edit = new vscode.WorkspaceEdit();
  edit.set(uri, edits);
  assert.ok(await vscode.workspace.applyEdit(edit), "applyEdit was rejected");
  return document.getText();
}

suite("poly-lsp in a real editor", () => {
  suiteSetup(async function() {
    this.timeout(120_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    // Opening a supported file is what a user does; if the activation events
    // are wrong this never resolves and the whole suite fails loudly.
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(
        writeFile("activation.sql", "select 1\n"),
      ),
    );
    await eventually("the extension to activate", () => extension.isActive || undefined);
  });

  // The VSIX ships one binary with one extension and versions them together,
  // so the pair the test host just wired up has to agree. A mismatch here is
  // the same defect a user would see as a warning badge, caught before release
  // rather than by whoever installs it.
  test("the binary it talks to is its own version", () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const serverPath = vscode.workspace
      .getConfiguration("poly")
      .get<string>("serverPath");
    assert.ok(serverPath, "the test host was given no poly.serverPath");
    const reported = execFileSync(serverPath, ["--version"], {
      encoding: "utf8",
    }).trim();
    assert.strictEqual(
      reported,
      `poly ${extension?.packageJSON.version}`,
      "binary and extension versions have drifted",
    );
  });

  test("contributes every command it declares", async () => {
    const registered = await vscode.commands.getCommands(true);
    const missing = COMMANDS.filter((id) => !registered.includes(id));
    assert.deepStrictEqual(missing, [], "declared but never registered");
  });

  // VSCode ships no formatter for either language, so any edit at all can only
  // have come from poly's client — which is exactly the registration that
  // broke twice while the protocol tests stayed green.
  // The go.work command's own body needs a modal answer and two real modules,
  // neither of which a test host can supply. What it can pin down is the part
  // that decides where the file lands -- and landing it in the wrong directory
  // is the failure mode that matters, because that directory is usually
  // outside every folder the window has open.
  // The lens is the only entry point most people will ever see for
  // `poly deadcode`, and the thing that breaks it is invisible from a unit
  // test: headers push the first real line well off line 0, and a lens
  // anchored to the wrong line silently stops rendering.
  async function deadCodeLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const lenses = await eventually("the dead code lens", async () => {
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        uri,
        10,
      );
      return found && found.length > 0 ? found : undefined;
    });
    return lenses.filter((lens) => lens.command?.command === "poly.analyzeDeadCode");
  }

  test("a Go file's lens lands past its build tag and licence header", async () => {
    const mine = await deadCodeLenses(
      writeFile(
        "buildtagged.go",
        "//go:build linux\n\n// Copyright somebody.\n\npackage main\n\nfunc main() {}\n",
      ),
    );
    assert.strictEqual(mine.length, 1, "expected exactly one dead code lens");
    assert.strictEqual(mine[0].range.start.line, 4, "lens is not on the package clause");
  });

  // Every language `poly deadcode` can answer about gets the same lens, and
  // each one hides its first real line behind something different: a shebang
  // in Python, a block comment in TypeScript.
  test("a Python file's lens lands past its shebang and header comment", async () => {
    const mine = await deadCodeLenses(
      writeFile(
        "headed.py",
        "#!/usr/bin/env python3\n# Copyright somebody.\n\nimport os\n\nprint(os.name)\n",
      ),
    );
    assert.strictEqual(mine.length, 1, "expected exactly one dead code lens");
    assert.strictEqual(mine[0].range.start.line, 3, "lens is not on the first statement");
  });

  test("a TypeScript file's lens lands past its block comment", async () => {
    const mine = await deadCodeLenses(
      writeFile(
        "headed.ts",
        "/*\n * Copyright somebody.\n */\n\nexport const answer = 42;\n",
      ),
    );
    assert.strictEqual(mine.length, 1, "expected exactly one dead code lens");
    assert.strictEqual(mine[0].range.start.line, 4, "lens is not on the first statement");
  });

  // Rust has no whole-program dead code analysis to dispatch to, so the lens
  // must not appear: an entry point to a command that answers "nothing to
  // analyse" is worse than no entry point.
  test("a language with no dead code analysis gets no lens", async () => {
    const uri = writeFile("plain.rs", "pub fn f() {}\n");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      uri,
      10,
    );
    const mine = (found ?? []).filter(
      (lens) => lens.command?.command === "poly.analyzeDeadCode",
    );
    assert.deepStrictEqual(mine, [], "Rust has no deadcode tool to offer");
  });

  test("a go.work goes to the deepest directory covering every module", () => {
    const root = commonRoot([join("/a", "liba"), join("/a", "appb")]);
    assert.strictEqual(root, "/a");
    assert.deepStrictEqual(useLines(root!, [join("/a", "liba"), join("/a", "appb")]), [
      "./appb",
      "./liba",
    ]);

    // A module at the root itself is `.`, which is what go writes.
    assert.deepStrictEqual(useLines("/a", ["/a", join("/a", "sub")]), [".", "./sub"]);

    // One module is its own root; nested modules resolve to the outer one.
    assert.strictEqual(commonRoot([join("/a", "one")]), join("/a", "one"));
    assert.strictEqual(commonRoot([join("/a", "one"), join("/a", "one", "in")]), join("/a", "one"));

    // Nothing to cover, and nothing in common: both have to say so rather than
    // return a root that would put the file somewhere arbitrary.
    assert.strictEqual(commonRoot([]), undefined);
  });

  test("registers a formatter for sql", async () => {
    const text = await formatted(writeFile("messy.sql", "select a,b from t\n"));
    assert.strictEqual(text, "select a, b from t\n");
  });

  test("registers a formatter for python", async () => {
    const text = await formatted(
      writeFile("messy.py", "def  f( a,b ):\n    return a+b\n"),
    );
    assert.strictEqual(text, "def f(a, b):\n    return a + b\n");
  });

  test("publishes sqruff diagnostics into the Problems panel", async () => {
    const uri = writeFile("bad.sql", "select a,b from t\n");
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
    );
    const diagnostics = await eventually("sqruff diagnostics", () => {
      const found = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.source === "sqruff");
      return found.length > 0 ? found : undefined;
    });
    assert.ok(diagnostics[0].message.length > 0, "empty diagnostic message");

    // Problems has to carry the remedy the terminal carries, in the same
    // words (A4). `select a,b` trips LT01, which sqruff marks fixable, so a
    // diagnostic without the fix line means the CLI and the editor disagree
    // about the same violation.
    assert.ok(
      diagnostics.some((d) => d.message.includes("fix: run `poly fmt`")),
      `no fix line: ${diagnostics.map((d) => d.message).join(" | ")}`,
    );
  });

  // sqruff has no documentation site, so its findings carry no link and the
  // prose compiled into the binary is the only answer to "why is this a rule".
  // The server advertises hoverProvider and the client registers it from that
  // alone -- no extension code is involved, which is exactly why only the real
  // editor can prove the hover arrives.
  test("hovering a sqruff finding shows its rule documentation", async () => {
    const uri = writeFile("hover.sql", "select a,b from t\n");
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
    );
    const flagged = await eventually(
      "a sqruff diagnostic to hover",
      () => vscode.languages.getDiagnostics(uri).find((d) => d.source === "sqruff"),
    );

    const hovers = await eventually("the rule hover", async () => {
      const found = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        flagged.range.start,
      );
      return found?.length ? found : undefined;
    });
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === "string" ? c : c.value))
      .join("\n");
    assert.ok(text.includes("**sqruff/"), `no rule heading: ${text}`);
    // sqruff's own section headings: if these are gone the hover has stopped
    // being the tool's documentation and become poly's paraphrase of it.
    assert.ok(text.includes("Best practice"), `not the rule docs: ${text}`);
  });

  // poly declares no definition provider at initialize -- it cannot, because an
  // LSP capability is server-wide and poly speaks for 29 languages while gopls
  // answers for one. It registers dynamically once gopls is up, scoped to Go,
  // and whether VSCode acts on a registration that arrives after initialize is
  // precisely what no protocol test can tell us.
  test("routes go-to-definition for Go to gopls", async function() {
    this.timeout(60_000);
    try {
      execFileSync("gopls", ["version"], { stdio: "ignore" });
    } catch {
      // Loudly, not silently: poly never installs a language server, so a
      // machine without one genuinely cannot run this.
      console.log("      skipped: gopls is not on PATH");
      this.skip();
    }
    const uri = writeFile(
      "greet.go",
      `package main

func Greet(name string) string {
\treturn "hello " + name
}

func main() {
\tprintln(Greet("world"))
}
`,
    );
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
    );
    // Position is inside `Greet` at the call site on line 8; the definition is
    // on line 3. gopls needs a moment to load the package, so poll.
    const locations = await eventually("gopls to resolve the definition", async () => {
      const found = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeDefinitionProvider",
        uri,
        new vscode.Position(7, 10),
      );
      return found?.length ? found : undefined;
    });
    assert.strictEqual(
      locations[0].range.start.line,
      2,
      "definition did not land on the declaration",
    );
    assert.ok(locations[0].uri.fsPath.endsWith("greet.go"), locations[0].uri.fsPath);
  });

  // A parse failure used to come back as an LSP error, which VSCode shows as a
  // toast that names no line and cannot be clicked. Only the real editor can
  // prove it now lands in Problems instead.
  test("reports a parse failure as a diagnostic, not a popup", async () => {
    const uri = writeFile("broken.yaml", "a: 1\n  b: 2\n");
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand(
      "vscode.executeFormatDocumentProvider",
      uri,
      { tabSize: 2, insertSpaces: true },
    );
    const diagnostic = await eventually(
      "the format error",
      () => vscode.languages.getDiagnostics(uri).find((d) => d.source === "poly"),
    );
    assert.strictEqual(diagnostic.range.start.line, 1, "points at line 2");
    assert.ok(
      diagnostic.range.end.character > diagnostic.range.start.character,
      "a zero-width range draws no squiggle",
    );
  });

  // The other half of the test above. YAML has no poly rule that reports a
  // parse failure, so there the formatter's error is the only report of it;
  // TypeScript has one, and a broken .ts used to draw two squiggles over the
  // same character -- `typescript/syntax` from the linter on change and
  // `poly/format` from the formatter on save, same line, same column, the same
  // sentence. Only the real editor can show which of them the Problems panel
  // ends up with, because the merge happens on the way out of the server.
  //
  // TypeScript rather than TOML, which is where this test started: the host
  // runs poly-lsp alone, and the `toml` language id comes from poly-highlight,
  // so a .toml file is plaintext here and never reaches the document selector.
  test("a file that does not parse reports it once", async () => {
    const uri = writeFile("broken.ts", "const = 1\n");
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await eventually(
      "the syntax finding",
      () => vscode.languages.getDiagnostics(uri).find((d) => d.source === "typescript"),
    );
    // The server publishes before it answers this request and the client
    // handles messages in order, so anything the formatter had to say has
    // arrived by the time this resolves -- no sleep, and no false pass.
    await vscode.commands.executeCommand(
      "vscode.executeFormatDocumentProvider",
      uri,
      { tabSize: 2, insertSpaces: true },
    );
    // `ts` is the built-in TypeScript service, entitled to its own opinion
    // about the same file. `poly` is the formatter's copy of the linter's, and
    // it is the only source this test is about.
    const sources = vscode.languages.getDiagnostics(uri).map((d) => d.source);
    assert.ok(sources.includes("typescript"), `lost the syntax finding: ${sources}`);
    assert.ok(
      !sources.includes("poly"),
      `the formatter repeated a parse failure the linter already reported: ${sources}`,
    );
  });

  // The batch commands go through workspace/executeCommand rather than the
  // document APIs, so they exercise a path no formatting test touches.
  test("Format Folder rewrites files on disk", async () => {
    const folder = join(workspaceRoot(), "batch");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "b.json");
    writeFileSync(file, "{\"b\":1,  \"a\":2}");

    await vscode.commands.executeCommand(
      "poly.formatPath",
      vscode.Uri.file(folder),
    );
    assert.strictEqual(readFileSync(file, "utf8"), "{ \"b\": 1, \"a\": 2 }\n");
  });

  // poly claims the formatter slot and stops there. It used to also declare
  // `editor.formatOnSave: true` for all 39 activated languages, which outranks
  // the user's own global setting -- so a user who had deliberately turned
  // format-on-save off got it back on for most of the files they open, by
  // installing a formatter. Deciding *who* formats is poly's business;
  // deciding *when* is the user's, and poly.format.enabled is the switch for
  // suspending it without touching either.
  //
  // Asserted against the manifest as well as against the editor: the editor
  // half reads a user setting when there is one, so on a profile that already
  // turned format-on-save on it would pass no matter what poly declares.
  test("poly claims the formatter slot without switching format-on-save on", () => {
    const uri = writeFile("defaults.py", "x = 1\n");
    const editor = vscode.workspace.getConfiguration("editor", {
      uri,
      languageId: "python",
    });
    assert.strictEqual(editor.get<string>("defaultFormatter"), EXTENSION_ID);

    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON;
    const forced = Object.entries(
      pkg.contributes.configurationDefaults as Record<string, Record<string, unknown>>,
    ).filter(([, declared]) => "editor.formatOnSave" in declared);
    assert.deepStrictEqual(forced.map(([language]) => language), []);
  });

  // The toolchain languages were held back on the theory that rust-analyzer,
  // gopls and clangd own them. poly formats rust, c, cpp, swift and terraform
  // by calling the same binary those servers call, so the output is identical,
  // and holding them back meant a .rs file in an editor with no rust-analyzer
  // never formatted at all -- which is how this was reported.
  test("poly is the formatter for the toolchain languages too", () => {
    for (const languageId of ["rust", "go", "c", "cpp", "swift", "terraform"]) {
      const editor = vscode.workspace.getConfiguration("editor", {
        uri: vscode.Uri.file(join(workspaceRoot(), `x.${languageId}`)),
        languageId,
      });
      assert.strictEqual(
        editor.get<string>("defaultFormatter"),
        EXTENSION_ID,
        `${languageId} should format with poly`,
      );
    }
  });

  // .editorconfig is resolved by the daemon and applied here, and neither half
  // is observable outside a real editor: `editor.options` exists only on a live
  // TextEditor, and an onWillSaveTextDocument participant only runs inside a
  // real save. An .ini is deliberately the subject -- poly does not format it,
  // so this is the whole of what poly does for the file, and it is the case an
  // editor-side EditorConfig extension was there for.
  function writeEditorConfig(): void {
    writeFile(
      ".editorconfig",
      "root = true\n\n[*.ini]\nindent_style = space\nindent_size = 3\n"
        + "trim_trailing_whitespace = true\ninsert_final_newline = true\n",
    );
  }

  test("applies .editorconfig indentation to a file poly does not format", async () => {
    writeEditorConfig();
    const document = await vscode.workspace.openTextDocument(
      writeFile("indent.ini", "[section]\n"),
    );
    const editor = await vscode.window.showTextDocument(document);
    // 3 is a width nothing arrives at by accident: editor.detectIndentation
    // guesses from the file, and this file has no indentation to guess from.
    await eventually(
      "the .editorconfig indent width",
      () => (editor.options.tabSize === 3 ? true : undefined),
    );
    assert.strictEqual(editor.options.insertSpaces, true);
  });

  test("applies .editorconfig save fixes to a file poly does not format", async () => {
    writeEditorConfig();
    const uri = writeFile("save.ini", "[section]\n");
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    // Dirty the buffer first: saving a clean document runs no participants, so
    // writing the trailing whitespace straight to disk would prove nothing.
    await editor.edit((builder) => builder.insert(new vscode.Position(1, 0), "key = value   "));
    assert.ok(await document.save(), "the save was rejected");
    assert.strictEqual(
      readFileSync(uri.fsPath, "utf8"),
      "[section]\nkey = value\n",
      "trailing whitespace trimmed and the file terminated",
    );
  });

  // Two lists in package.json describe the same set of languages, and nothing
  // else notices when one grows without the other: a language added to
  // activationEvents but not to configurationDefaults activates poly and then
  // leaves Format Document pointing at whatever else is installed.
  test("configurationDefaults covers every activated language", () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON;
    const activated = (pkg.activationEvents as string[])
      .filter((event) => event.startsWith("onLanguage:"))
      .map((event) => event.slice("onLanguage:".length));
    const declared = Object.keys(pkg.contributes.configurationDefaults)
      .map((section) => section.slice(1, -1));
    assert.deepStrictEqual(
      activated.filter((language) => !declared.includes(language)),
      [],
      "activated but poly never claims the formatter slot",
    );
    assert.deepStrictEqual(
      declared.filter((language) => !activated.includes(language)),
      [],
      "claims the formatter slot but never activates poly",
    );
  });
});
