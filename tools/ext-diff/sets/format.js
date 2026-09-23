// poly's format switch against tombonnike.vscode-status-bar-format-toggle.
//
// Both put a button in the status bar that means "stop rewriting my files",
// and they implement it in opposite places: tombonnike writes `false` into
// `editor.formatOnSave`/`OnPaste`/`OnType` at user scope, so it governs every
// formatter and only the automatic triggers; poly answers its own formatting
// requests with nothing, so it governs every trigger and only its own
// formatter. Neither sentence says what happens to a file, so this asks,
// once per thing in the editor that can rewrite one.
//
// Every source is tried twice: with the switch on, to prove it rewrites the
// file at all -- a source that changes nothing when on would pass as "stopped"
// when off -- and again with it off. The switch is then flipped back and the
// settings file read, because "where does the state live" decides what a
// per-language block or a workspace setting can override.
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * Each rewrite source, with the file it is tried on.
 *
 * JSON where a formatter is the subject, because both sides have one for it:
 * poly on one side and the editor's built-in on the other. The content is
 * chosen so the only thing that can change it is the source named: the
 * TypeScript import line is already in every formatter's shape and only
 * organize-imports removes the unused name.
 */
const SOURCES = [
  {
    id: "format-document",
    label: "Format Document (json)",
    file: "fmt.json",
    text: "{\"a\":1,\"b\":[1,2]}\n",
    act: "format",
  },
  {
    id: "format-on-save",
    label: "format on save, editor.formatOnSave at user scope (json)",
    file: "save.json",
    text: "{\"a\":1,\"b\":[1,2]}\n",
    act: "save",
  },
  {
    id: "format-on-save-language",
    label: "format on save, [jsonc] editor.formatOnSave (jsonc)",
    file: "save.jsonc",
    text: "{\"a\":1,\"b\":[1,2]}\n",
    act: "save",
  },
  {
    id: "format-on-paste",
    label: "format on paste (json)",
    file: "paste.json",
    text: "\n",
    act: "paste",
    pasted: "{\"a\":1,\"b\":[1,2]}",
  },
  {
    id: "format-on-type",
    label: "format on type, `;` (typescript)",
    file: "type.ts",
    text: "export const   value   =   1\n",
    act: "type",
    typed: ";",
  },
  {
    id: "organize-imports",
    label: "editor.codeActionsOnSave source.organizeImports (typescript)",
    file: "imports.ts",
    text: "import { unused, used } from \"./lib\";\n\nexport const value = used;\n",
    act: "save",
  },
  {
    id: "trim-trailing-whitespace",
    label: "files.trimTrailingWhitespace (plaintext)",
    file: "trim.txt",
    text: "first\ntrailing   \n",
    act: "save",
  },
  {
    id: "editorconfig",
    label: ".editorconfig trim_trailing_whitespace + insert_final_newline (ini, applied by poly)",
    file: "ec.ini",
    text: "key = value   \nother = 2",
    act: "save",
  },
  {
    id: "other-formatter-document",
    label: "another extension's formatter: Format Document (plaintext)",
    file: "other.txt",
    text: "lowercase text\n",
    act: "format",
  },
  {
    id: "other-formatter-save",
    label: "another extension's formatter: format on save (plaintext)",
    file: "other-save.txt",
    text: "lowercase text\n",
    act: "save",
  },
];

/** What `imports.ts` imports from, so organize-imports has a real module to reason about. */
const LIB = "export const used = 1;\nexport const unused = 2;\n";

const TOGGLE = { original: "formattingToggle.toggleFormat", poly: "poly.toggleFormat" };

/** The settings either switch could be keeping its state in. */
const KEYS = [
  "poly.format.enabled",
  "editor.formatOnSave",
  "editor.formatOnPaste",
  "editor.formatOnType",
  "editor.codeActionsOnSave",
  "files.trimTrailingWhitespace",
];

module.exports = {
  id: "format",
  title: "format toggle vs tombonnike.vscode-status-bar-format-toggle",
  original: ["tombonnike", "vscode-status-bar-format-toggle"],

  settings() {
    // Every automatic source armed at user scope, as a user who installed a
    // toggle would have them -- a toggle over settings that are already off
    // has nothing to switch. `[ini]` keeps the editor's own trimming off the
    // .editorconfig case, so what trims that file is poly or nobody.
    return {
      "editor.formatOnSave": true,
      "editor.formatOnPaste": true,
      "editor.formatOnType": true,
      "editor.codeActionsOnSave": { "source.organizeImports": "explicit" },
      "files.trimTrailingWhitespace": true,
      "[ini]": { "files.trimTrailingWhitespace": false },
      // The shape of this repo owner's own settings: format-on-save turned on
      // per language rather than globally. A switch that writes the global
      // key cannot reach this one.
      "[jsonc]": { "editor.formatOnSave": true },
    };
  },

  fixture(workspace) {
    // The rest is written by `observe`, one fresh copy per attempt.
    writeFileSync(
      join(workspace, ".editorconfig"),
      "root = true\n\n[*.ini]\ntrim_trailing_whitespace = true\ninsert_final_newline = true\n",
    );
    return { sources: SOURCES, toggle: TOGGLE, keys: KEYS };
  },

  async observe(ctx) {
    const { vscode, side, manifest, folder } = ctx;
    const { readFileSync, existsSync } = require("node:fs");
    const settingsFile = join(process.env.POLY_EXT_DIFF_USER_DATA, "User", "settings.json");

    // "Another extension's formatter", registered from here: it is the one
    // formatter neither toggle was written for, and upper-casing is a change
    // no other participant makes.
    const other = vscode.languages.registerDocumentFormattingEditProvider(
      { scheme: "file", language: "plaintext", pattern: "**/other*.txt" },
      {
        provideDocumentFormattingEdits(document) {
          const all = new vscode.Range(0, 0, document.lineCount, 0);
          return [vscode.TextEdit.replace(all, document.getText().toUpperCase())];
        },
      },
    );

    const state = () => {
      const config = vscode.workspace.getConfiguration();
      const values = {};
      for (const key of manifest.keys) {
        const seen = config.inspect(key);
        values[key] = { user: seen?.globalValue, workspace: seen?.workspaceValue, default: seen?.defaultValue };
      }
      const jsonc = vscode.workspace.getConfiguration("editor", { languageId: "jsonc" }).inspect("formatOnSave");
      values["[jsonc] editor.formatOnSave"] = {
        user: jsonc?.globalLanguageValue,
        workspace: jsonc?.workspaceLanguageValue,
      };
      return {
        values,
        userSettingsJson: readFileSync(settingsFile, "utf8"),
        workspaceSettingsJson: existsSync(join(folder.fsPath, ".vscode", "settings.json"))
          ? readFileSync(join(folder.fsPath, ".vscode", "settings.json"), "utf8")
          : null,
      };
    };

    /** The document's next change, then quiet -- or its version unchanged at the deadline. */
    const settleEdits = (document, timeout) =>
      new Promise((resolve) => {
        let quiet;
        const finish = () => {
          subscription.dispose();
          clearTimeout(quiet);
          clearTimeout(deadline);
          resolve();
        };
        const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document !== document) return;
          clearTimeout(quiet);
          quiet = setTimeout(finish, 300);
        });
        const deadline = setTimeout(finish, timeout);
      });

    /**
     * A file that has never been open in this window, with `text` in it.
     *
     * Never the same path twice. A closed editor's document outlives it, so
     * rewriting a file the last attempt saved and opening it again hands back
     * the old model -- whose save then fails as a conflict with the newer file
     * on disk, and every save-time source read "stopped" on both sides.
     */
    const fresh = (phase, name, text) => {
      const dir = join(folder.fsPath, phase);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), text);
      return vscode.Uri.joinPath(folder, phase, name);
    };

    /** One attempt at one source: what the file said after it, and whether it moved. */
    const attempt = async (source, phase) => {
      // organize-imports needs its import to resolve beside it.
      fresh(phase, "lib.ts", LIB);
      const uri = fresh(phase, source.file, source.text);
      const editor = await ctx.openAlone(uri);
      const document = editor.document;
      let untouched = source.text;
      let acted = true;
      if (source.act === "format") {
        await vscode.commands.executeCommand("editor.action.formatDocument");
        await settleEdits(document, 1_000);
      } else if (source.act === "save") {
        // Dirty without a net change: an explicit save of a clean file may
        // skip the participants, and this is about what they do.
        const end = document.lineAt(0).range.end;
        await editor.edit((edit) => edit.insert(end, " "));
        await editor.edit((edit) => edit.delete(new vscode.Range(end, end.translate(0, 1))));
        await vscode.commands.executeCommand("workbench.action.files.save");
      } else if (source.act === "paste") {
        await vscode.env.clipboard.writeText(source.pasted);
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        const settled = settleEdits(document, 3_000);
        await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
        await settled;
        untouched = source.pasted + source.text;
        // The system clipboard is shared with the rest of the machine, and a
        // paste that never arrived has nothing to say about format-on-paste.
        acted = document.getText().replace(/\s/g, "").includes(source.pasted.replace(/\s/g, "").slice(0, 5));
      } else if (source.act === "type") {
        const end = document.lineAt(0).range.end;
        editor.selection = new vscode.Selection(end, end);
        const settled = settleEdits(document, 3_000);
        await vscode.commands.executeCommand("type", { text: source.typed });
        await settled;
        untouched = `${source.text.split("\n")[0]}${source.typed}\n`;
        acted = document.getText().includes(source.typed);
      }
      const text = source.act === "save" ? readFileSync(uri.fsPath, "utf8") : document.getText();
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      return { acted, changed: acted ? text !== untouched : null, text };
    };

    // The TypeScript server answers organize-imports and on-type formatting,
    // and a question asked before it has loaded the project is answered
    // "nothing", which would read as "the switch stopped it".
    const ts = fresh("warm", "lib.ts", LIB);
    await ctx.openAlone(ts);
    const tsReady = await ctx.until(
      async () => (await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", ts) ?? []).length,
      (count) => count > 0,
      { timeout: 60_000 },
    );

    const results = SOURCES.map((source) => ({ id: source.id, label: source.label, file: source.file }));
    const before = state();
    await ctx.openAlone(fresh("show-on", "fmt.json", SOURCES[0].text));
    await ctx.shot("switch-on", "the status bar with the switch on, fmt.json open");
    for (const [i, source] of SOURCES.entries()) results[i].on = await attempt(source, "on");

    await vscode.commands.executeCommand(manifest.toggle[side]);
    const off = state();
    await ctx.openAlone(fresh("show-off", "fmt.json", SOURCES[0].text));
    await ctx.shot("switch-off", "the status bar after the switch was turned off, fmt.json open");
    for (const [i, source] of SOURCES.entries()) results[i].off = await attempt(source, "off");
    // Once more for the picture only, and left open: what a user sees after
    // pressing Format Document with the switch off.
    const shown = await ctx.openAlone(fresh("show-formatted", "fmt.json", SOURCES[0].text));
    await vscode.commands.executeCommand("editor.action.formatDocument");
    await settleEdits(shown.document, 1_000);
    await ctx.shot("format-document-off", "fmt.json after Format Document with the switch off");
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

    // Back on, so the round trip is measured too: a switch that cannot put
    // back what it found has changed the user's settings for good.
    await vscode.commands.executeCommand(manifest.toggle[side]);
    const restored = state();
    other.dispose();
    return {
      toggleCommand: manifest.toggle[side],
      typescriptReady: !tsReady.timedOut,
      state: { before, off, restored },
      sources: results,
    };
  },

  diff(original, poly) {
    const problems = [];
    if (!original.typescriptReady || !poly.typescriptReady) {
      problems.push("the TypeScript server never answered, so organize-imports and format-on-type measured nothing");
    }
    /** What the switch did to one source on one side, in one word. */
    const verdict = (one) => {
      if (!one.on.acted || !one.off.acted) return "not-performed";
      if (!one.on.changed) return "not-armed";
      return one.off.changed ? "still-rewrites" : "stopped";
    };
    const rows = original.sources.map((theirs) => {
      const ours = poly.sources.find((one) => one.id === theirs.id);
      const o = verdict(theirs);
      const p = verdict(ours);
      const comparable = ![o, p].includes("not-performed");
      return {
        source: theirs.label,
        original: o,
        poly: p,
        agree: comparable ? o === p : null,
        originalOff: theirs.off.text,
        polyOff: ours.off.text,
      };
    });
    for (const row of rows.filter((one) => one.agree === null)) {
      problems.push(`${row.source}: the action itself did not happen on one side (${row.original} / ${row.poly})`);
    }
    /** Every setting whose user- or workspace-scope value the switch moved. */
    const moved = (side) =>
      Object.entries(side.state.off.values)
        .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(side.state.before.values[key]))
        .map(([key, value]) => ({
          key,
          before: side.state.before.values[key],
          off: value,
          restored: side.state.restored.values[key],
          roundTrips: JSON.stringify(side.state.restored.values[key]) === JSON.stringify(side.state.before.values[key]),
        }));
    const state = [
      ...moved(original).map((one) => ({ side: "original", ...one })),
      ...moved(poly).map((one) => ({ side: "poly", ...one })),
    ];
    for (const [label, side] of [["original", original], ["poly", poly]]) {
      if (side.state.off.workspaceSettingsJson !== side.state.before.workspaceSettingsJson) {
        problems.push(`${label}'s switch wrote the workspace's .vscode/settings.json`);
      }
    }
    return {
      summary: {
        sources: rows.length,
        disagreements: rows.filter((row) => row.agree === false).length,
        originalStops: rows.filter((row) => row.original === "stopped").map((row) => row.source),
        polyStops: rows.filter((row) => row.poly === "stopped").map((row) => row.source),
      },
      notes: [
        "verdicts: stopped = rewrote the file with the switch on and not with it off; "
        + "still-rewrites = rewrote it both times; not-armed = did not rewrite it even with the switch on "
        + "(nothing on that side performs this rewrite, so the switch has nothing to stop).",
      ],
      rows,
      state,
      problems,
    };
  },
};
