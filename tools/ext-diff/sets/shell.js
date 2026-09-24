// Shell navigation through poly against mads-hartmann.bash-ide-vscode.
//
// Both sides end at the same program -- bash-language-server -- and that is
// why this is worth asking: bash-ide starts it itself, with its own settings,
// and poly-lsp starts it from PATH behind a proxy that rewrites what passes
// through. Whatever differs here, the proxy did. On top of that poly
// draws its reference count from the answers, which is the part of the
// feature a user actually looks at.
//
// Four files, because the three function spellings are one question and the
// file names are three more: a `.sh` every tool recognises, a `.zsh`, a
// script with no extension that only its shebang identifies, and `.bashrc`.
const { chmodSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * The fixture, with each function's name marked by `@` where it is declared.
 * The marker is removed before writing; it is only how the positions are kept
 * next to the text they point into.
 */
const FILES = {
  "main.sh": `#!/usr/bin/env bash
@foo() {
  echo foo
}

function @bar {
  echo bar
}

function @baz() {
  echo baz
}

foo
foo
bar
bar
baz
baz
`,
  "prompt.zsh": `@greet() {
  echo hi
}

greet
greet
`,
  deploy: `#!/bin/bash
@ship() {
  echo shipping
}

ship
ship
`,
  ".bashrc": `alias ll='ls -l'
@mkcd() {
  mkdir -p "$1" && cd "$1"
}

mkcd /tmp/one
mkcd /tmp/two
`,
};

/** Where the `bash-language-server` shim lives, so poly-lsp finds it on PATH. */
const shimDir = (env) => join(env.scratch, "bin");

module.exports = {
  id: "shell",
  title: "shell references vs mads-hartmann.bash-ide-vscode",
  original: ["mads-hartmann", "bash-ide-vscode"],

  settings(side) {
    return side === "poly"
      ? { "poly.languageServers": true, "poly.referencesCodeLens.enabled": true }
      : {};
  },

  /**
   * The server poly-lsp will start, from PATH as it does in real use.
   *
   * The one bundled in the bash-ide VSIX, behind a two-line shim, rather than
   * a second install: the question is what poly does with the server, and
   * running a different version of it on each side would make every
   * disagreement a version question first. Nothing is installed globally.
   */
  launchEnv(side, env) {
    if (side !== "poly") return {};
    const bin = shimDir(env);
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, "bash-language-server");
    const cli = join(env.original, "node_modules", "bash-language-server", "out", "cli.js");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
    chmodSync(shim, 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
  },

  fixture(workspace) {
    const functions = [];
    for (const [name, marked] of Object.entries(FILES)) {
      const lines = marked.split("\n");
      lines.forEach((line, index) => {
        const col = line.indexOf("@");
        if (col >= 0) {
          functions.push({ file: name, name: /@(\w+)/.exec(line)[1], line: index, col });
        }
      });
      writeFileSync(join(workspace, name), marked.replaceAll("@", ""));
    }
    return { files: Object.keys(FILES), functions };
  },

  async observe(ctx) {
    const { vscode, side, manifest, folder } = ctx;
    const where = (location) => {
      const uri = location.uri ?? location.targetUri;
      const range = location.range ?? location.targetSelectionRange ?? location.targetRange;
      return `${vscode.workspace.asRelativePath(uri)}:${range.start.line + 1}:${range.start.character + 1}`;
    };
    const files = [];
    for (const name of manifest.files) {
      const uri = vscode.Uri.joinPath(folder, name);
      const editor = await ctx.openAlone(uri);
      // A language server reports symbols once it has parsed the file, and
      // the first answer after a cold start can be an empty list.
      const symbols = await ctx.until(
        async () =>
          (await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri) ?? []).map((one) => ({
            name: one.name,
            kind: vscode.SymbolKind[one.kind],
            line: (one.selectionRange ?? one.location?.range ?? one.range).start.line + 1,
          })),
        (list) => list.length > 0,
        { timeout: 30_000 },
      );
      const references = [];
      for (const fn of manifest.functions.filter((one) => one.file === name)) {
        const found = await vscode.commands.executeCommand(
          "vscode.executeReferenceProvider",
          uri,
          new vscode.Position(fn.line, fn.col),
        ) ?? [];
        references.push({ name: fn.name, at: `${fn.line + 1}:${fn.col + 1}`, locations: found.map(where).sort() });
      }
      // Resolved lenses, once their number holds. Only poly draws any; the
      // original side is asked too, so "none" is a measurement there rather
      // than an assumption.
      const lenses = await ctx.until(
        async () =>
          (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri, 100) ?? []).map((lens) => ({
            line: lens.range.start.line + 1,
            title: lens.command?.title ?? "(unresolved)",
            command: lens.command?.command ?? "",
          })),
        (list) => side === "original" || list.length > 0,
        { timeout: side === "poly" ? 30_000 : 3_000 },
      );
      const lensLines = new Set((lenses.answer ?? []).map((lens) => lens.line)).size;
      files.push({
        file: name,
        language: editor.document.languageId,
        symbols: symbols.answer ?? [],
        symbolsTimedOut: symbols.timedOut,
        references,
        lenses: lenses.answer ?? [],
        lensesTimedOut: side === "poly" && lenses.timedOut,
        // One drawn zone per line that has lenses, if the editor drew them.
        rendered: await ctx.renderedLenses(lensLines, side === "poly" ? 8_000 : 1_000),
      });
      await vscode.commands.executeCommand("outline.focus");
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
      // The Outline asks for symbols on its own schedule, and the first
      // baseline pictured "cannot provide outline information" on both sides
      // for a file both had just answered symbols for. Its rows are the
      // signal; the bound is for a side that really has no outline.
      const outline = await ctx.until(
        () =>
          ctx.screen.evaluate(`[...document.querySelectorAll(".pane")]
            .filter((pane) => /outline/i.test(pane.querySelector(".pane-header .title")?.textContent ?? ""))
            .flatMap((pane) => [...pane.querySelectorAll(".pane-body .monaco-list-row")].map((row) => row.textContent.trim()))`),
        (rows) => rows.length > 0,
        { timeout: 5_000, every: 200, stable: 2 },
      );
      files[files.length - 1].outlineOnScreen = outline.answer ?? [];
      await ctx.shot(
        `file-${name.replace(/^\./, "dot-").replace(".", "-")}`,
        `${name} (${editor.document.languageId}) with the outline open`,
      );
    }
    return { files };
  },

  diff(original, poly, manifest) {
    const problems = [];
    for (const side of [original, poly]) {
      if (side.files.every((file) => file.symbols.length === 0)) {
        problems.push(`${side.side} reported no symbols in any file: its server never answered`);
      }
    }
    const symbols = [];
    const references = [];
    const lenses = [];
    const drawn = [];
    for (const name of manifest.files) {
      const theirs = original.files.find((one) => one.file === name);
      const ours = poly.files.find((one) => one.file === name);
      const asked = [...new Set(ours.lenses.map((lens) => lens.line))].length;
      drawn.push({
        file: name,
        polyLensesWhenAsked: ours.lenses.map((lens) => `${lens.line}: ${lens.title}`).join(" | ") || null,
        polyLensesOnScreen: ours.rendered.join(" | ") || null,
        originalOutlineOnScreen: theirs.outlineOnScreen.join(", ") || null,
        polyOutlineOnScreen: ours.outlineOnScreen.join(", ") || null,
        agree: ours.rendered.length === asked && theirs.outlineOnScreen.join() === ours.outlineOnScreen.join(),
      });
      const names = (side) => side.symbols.map((one) => `${one.name}@${one.line}`).sort().join(", ");
      symbols.push({
        file: name,
        language: `${theirs.language} / ${ours.language}`,
        original: names(theirs) || null,
        poly: names(ours) || null,
        agree: names(theirs) === names(ours),
      });
      for (const fn of manifest.functions.filter((one) => one.file === name)) {
        const o = theirs.references.find((one) => one.name === fn.name).locations;
        const p = ours.references.find((one) => one.name === fn.name).locations;
        references.push({
          file: name,
          function: fn.name,
          original: o.join(" "),
          poly: p.join(" "),
          agree: o.join() === p.join(),
        });
        // What the lens should say, by the original's own answer: every
        // reference but the declaration. A lens that counts differently from
        // the server it reads is wrong whichever count is right.
        const expected = o.filter((loc) => !loc.endsWith(`:${fn.line + 1}:${fn.col + 1}`)).length;
        const titles = ours.lenses.filter((lens) => lens.line === fn.line + 1).map((lens) => lens.title);
        const refs = titles.find((title) => /refs?$/.test(title)) ?? null;
        const count = refs === null ? null : /^no refs$/.test(refs) ? 0 : Number(/^(\d+)/.exec(refs)?.[1]);
        lenses.push({
          file: name,
          function: fn.name,
          originalRefsExcludingDeclaration: expected,
          polyLens: titles.join(" | ") || null,
          agree: count === expected,
        });
      }
    }
    for (const side of [original, poly]) {
      for (const file of side.files.filter((one) => one.symbolsTimedOut)) {
        problems.push(`${side.side}: ${file.file} had no symbols after 30s`);
      }
    }
    return {
      summary: {
        symbolDisagreements: symbols.filter((row) => !row.agree).length,
        referenceDisagreements: references.filter((row) => !row.agree).length,
        lensMismatches: lenses.filter((row) => !row.agree).length,
        filesDrawnDifferently: drawn.filter((row) => !row.agree).map((row) => row.file),
      },
      notes: [
        "lenses: agree means poly's `N refs` equals the number of references the original side's server returned, minus the declaration.",
        "drawn: what the provider answers when asked again after the file settled, against what the editor put on screen "
        + "(lenses, and the Outline pane on both sides). They differ when a provider answered nothing when the editor "
        + "asked and never told it to ask again.",
      ],
      symbols,
      references,
      lenses,
      drawn,
      problems,
    };
  },
};
