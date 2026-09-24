// poly's unicode lint against nhoizey.gremlins, the extension it replaced.
//
// Two questions, and the second is the one the unit tests cannot ask:
//
//   * which characters each flags. gremlins' list is its settings default and
//     poly's is four tables in unicode.rs; both are read from where they live,
//     so the fixture grows when either list does.
//   * when. gremlins redraws on every keystroke. poly has two halves: its
//     lint rules run on open and on save, and only for files the client sends
//     to the daemon, and the editor's unicode highlight redraws on every
//     keystroke in every file. A character pasted into a buffer and looked at
//     before saving is the case the second half exists for.
//
// Five file types: three poly lints and two it does not, because "the rule has
// no language" (lsp.rs, above `unicode::check`) is only true for files the
// client sends to the daemon in the first place.
//
// poly's side counts a character as flagged when either half says so: a
// Problems entry, or the highlight's hover. The hover is the part of the
// highlight the extension API can see -- a decoration is invisible to it -- and
// it steps aside where the lint already reported the same character, so
// neither half alone is the whole answer.
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

/** Each fixture file and the comment prefix that keeps its own linters quiet. */
const FILES = [
  { name: "fixture.md", prefix: "" },
  { name: "fixture.py", prefix: "# " },
  { name: "fixture.sh", prefix: "# " },
  { name: "fixture.txt", prefix: "" },
  { name: "fixture.ini", prefix: "; " },
];

/**
 * Files a character is typed into, one poly lints and one it does not.
 *
 * ZERO WIDTH SPACE because both lists carry it: a character only one side
 * knows would measure the list again rather than the timing.
 */
const TYPED = { files: ["typed.md", "typed.txt"], text: "plain line\n", at: [0, 5], char: 0x200b };

/**
 * The unicode.rs the measured binary was built from, where that can be told.
 *
 * The binary is an argument and can come from another checkout, and the first
 * baseline showed why that matters: it ran a binary whose tables had grown
 * five characters against this tree's older source, and the fixture called
 * those five "not in poly's tables" in the same row that showed poly flagging
 * them. A binary at `<tree>/cli/target/release/poly` names its tree; anything
 * else falls back to this checkout.
 */
function unicodeSource(env) {
  const tree = resolve(env.polyBin, "..", "..", "..", "..");
  const beside = join(tree, "cli", "crates", "poly-engines", "src", "unicode.rs");
  return existsSync(beside) ? beside : join(env.ROOT, "cli", "crates", "poly-engines", "src", "unicode.rs");
}

/** The four tables `unicode::check` reads, parsed out of the Rust source. */
function polySets(file) {
  const source = readFileSync(file, "utf8");
  const sets = {};
  for (const table of ["INVISIBLE", "BIDI", "SPACES", "LOOKALIKE"]) {
    const block = new RegExp(`const ${table}: &\\[[^=]*= &\\[([\\s\\S]*?)\\n\\];`).exec(source);
    if (!block) throw new Error(`unicode.rs no longer has a ${table} table in the shape this reads`);
    sets[table] = [...block[1].matchAll(/'\\u\{([0-9A-Fa-f]+)\}'.*?\/\/ (.+)$/gm)].map((m) => ({
      cp: parseInt(m[1], 16),
      name: m[2].trim(),
    }));
    if (sets[table].length === 0) throw new Error(`read no characters out of ${table}`);
  }
  return sets;
}

/** gremlins' own default list, from the manifest of the copy that was installed. */
function gremlinsDefaults(extensionPath) {
  const pkg = JSON.parse(readFileSync(join(extensionPath, "package.json"), "utf8"));
  const characters = pkg.contributes.configuration.properties["gremlins.characters"].default;
  const found = [];
  for (const [hex, config] of Object.entries(characters)) {
    const range = /^([0-9a-f]+)(?:-([0-9a-f]+))?$/i.exec(hex);
    const first = parseInt(range[1], 16);
    const last = range[2] ? parseInt(range[2], 16) : first;
    for (let cp = first; cp <= last; cp++) {
      found.push({ cp, name: config.description, level: config.level ?? "error" });
    }
  }
  return found;
}

const hex = (cp) => cp.toString(16).toUpperCase().padStart(4, "0");

module.exports = {
  id: "unicode",
  title: "unicode lint vs nhoizey.gremlins",
  original: ["nhoizey", "gremlins"],

  settings(side) {
    return {
      // U+2029 is in gremlins' list, and the editor otherwise stops the run
      // with a modal offering to delete it -- which would also delete the case.
      "editor.unusualLineTerminators": "off",
      ...(side === "original"
        // Off by default: gremlins only decorates unless told to report, and a
        // decoration is invisible to the extension API.
        ? { "gremlins.showInProblemPane": true }
        : { "poly.lintOnSave": true, "poly.unicodeHighlight.enabled": true }),
    };
  },

  fixture(workspace, env) {
    const chars = new Map();
    const note = (cp, name, key, value) => {
      const entry = chars.get(cp) ?? { cp, hex: hex(cp), name: name.toUpperCase(), gremlins: null, poly: null };
      entry[key] = value;
      chars.set(cp, entry);
    };
    for (const one of gremlinsDefaults(env.original)) note(one.cp, one.name, "gremlins", one.level);
    const tables = unicodeSource(env);
    for (const [table, list] of Object.entries(polySets(tables))) {
      for (const one of list) note(one.cp, one.name, "poly", table);
    }
    // In neither list on purpose -- unicode.rs explains why poly leaves it
    // out -- and here as the control that both sides agree to ignore.
    note(0x2014, "EM DASH", "control", true);
    const ordered = [...chars.values()].sort((a, b) => a.cp - b.cp);

    const files = FILES.map(({ name, prefix }) => {
      const lines = [`${prefix}ext-diff: one character per line, between the brackets`];
      const rows = ordered.map((one) => {
        const head = `${prefix}U+${one.hex} [`;
        lines.push(`${head}${String.fromCodePoint(one.cp)}] ${one.name}`);
        return { line: lines.length - 1, col: head.length, cp: one.cp };
      });
      writeFileSync(join(workspace, name), `${lines.join("\n")}\n`);
      return { name, rows };
    });
    for (const name of TYPED.files) writeFileSync(join(workspace, name), TYPED.text);
    return { polyTablesFrom: tables, chars: ordered, files, typed: TYPED };
  },

  async observe(ctx) {
    const { vscode, side, manifest, folder } = ctx;
    const code = (d) => (typeof d.code === "object" && d.code !== null ? d.code.value : d.code);
    const mine = side === "original"
      ? (d) => d.source === "Gremlins tracker"
      : (d) => d.source === "poly" && /^unicode-/.test(String(code(d)));
    // The highlight's hover at one position, recognised by how it starts:
    // other providers (a language server, markdown) can answer there too.
    const highlight = async (uri, line, col) => {
      if (side === "original") return undefined;
      const hovers = await vscode.commands.executeCommand(
        "vscode.executeHoverProvider",
        uri,
        new vscode.Position(line, col),
      );
      return hovers
        .flatMap((hover) => hover.contents)
        .map((part) => (typeof part === "string" ? part : part.value))
        .find((value) => /^U\+[0-9A-F]{4} /.test(value));
    };
    const shape = (d) => ({
      line: d.range.start.line,
      col: d.range.start.character,
      endCol: d.range.end.character,
      severity: vscode.DiagnosticSeverity[d.severity],
      code: code(d) ?? null,
      message: d.message,
    });

    const files = [];
    for (const file of manifest.files) {
      const uri = vscode.Uri.joinPath(folder, file.name);
      const editor = await ctx.openAlone(uri);
      const settled = await ctx.settleDiagnostics(uri, mine, { first: 20_000 });
      const flagged = settled.diagnostics.map(shape);
      const rows = manifest.files.find((one) => one.name === file.name).rows;
      for (const row of rows) {
        if (flagged.some((d) => d.line === row.line)) continue;
        const said = await highlight(uri, row.line, row.col);
        if (said) {
          flagged.push({
            line: row.line,
            col: row.col,
            endCol: row.col + 1,
            severity: null,
            code: "highlight",
            message: said,
          });
        }
      }
      files.push({
        file: file.name,
        language: editor.document.languageId,
        // The whole list, not only this side's: a finding from somebody else
        // on the same line is what a reader sees in the picture too.
        others: vscode.languages.getDiagnostics(uri).filter((d) => !mine(d)).length,
        waitedMs: settled.ms,
        timedOut: settled.timedOut,
        flagged: flagged.sort((a, b) => a.line - b.line || a.col - b.col),
      });
      // "unicode" is in every gremlins message and in every poly code, and in
      // nothing the other linters on these files say.
      await ctx.problems("unicode");
      await ctx.shot(
        `open-${file.name.replace(".", "-")}`,
        `${file.name} (${editor.document.languageId}) after opening`,
      );
    }

    const typed = [];
    for (const name of manifest.typed.files) {
      const uri = vscode.Uri.joinPath(folder, name);
      const editor = await ctx.openAlone(uri);
      // Whatever linting the open triggers lands first, so what follows is
      // about the keystroke and not about the open.
      await ctx.settleDiagnostics(uri, () => true, { first: 3_000 });
      const [line, character] = manifest.typed.at;
      const here = (d) => mine(d) && d.range.start.line === line && d.range.start.character === character;
      await editor.edit((edit) =>
        edit.insert(new vscode.Position(line, character), String.fromCodePoint(manifest.typed.char))
      );
      // Either half of poly, the highlight first because it answers at once: a
      // hover is computed when asked, a lint is a round trip to the daemon.
      const flaggedHere = async (wait) => {
        const started = Date.now();
        const shown = await highlight(uri, line, character);
        return shown
          ? { diagnostics: [shown], ms: Date.now() - started }
          : ctx.settleDiagnostics(uri, here, { first: wait });
      };
      // Five seconds is longer than either side takes to answer anything it is
      // going to answer, and short enough that "no" costs little.
      const before = await flaggedHere(5_000);
      await ctx.problems("unicode");
      await ctx.shot(
        `typed-${name.replace(".", "-")}-unsaved`,
        `${name}: U+200B typed at 1:${character + 1}, not saved`,
      );
      await vscode.commands.executeCommand("workbench.action.files.save");
      const after = await flaggedHere(10_000);
      typed.push({
        file: name,
        language: editor.document.languageId,
        beforeSave: { flagged: before.diagnostics.length > 0, ms: before.ms },
        afterSave: { flagged: after.diagnostics.length > 0, ms: after.ms },
      });
    }
    return { files, typed };
  },

  /** One row per character per file, and the timing rows beside them. */
  diff(original, poly, manifest) {
    const problems = [];
    for (const side of [original, poly]) {
      if (side.files.every((file) => file.flagged.length === 0)) {
        problems.push(`${side.side} flagged nothing in any file, so every row below compares nothing`);
      }
    }
    const byCp = new Map(manifest.chars.map((one) => [one.cp, one]));
    const rows = [];
    for (const file of manifest.files) {
      const theirs = original.files.find((one) => one.file === file.name);
      const ours = poly.files.find((one) => one.file === file.name);
      const at = (side, line) => side.flagged.filter((d) => d.line === line);
      for (const row of file.rows) {
        const char = byCp.get(row.cp);
        const o = at(theirs, row.line);
        const p = at(ours, row.line);
        rows.push({
          file: file.name,
          language: ours.language,
          line: row.line + 1,
          col: row.col + 1,
          codepoint: `U+${char.hex}`,
          name: char.name,
          inGremlinsDefaults: char.gremlins,
          inPolyTables: char.poly,
          original: o.length > 0 ? o.map((d) => d.severity).join(",") : null,
          poly: p.length > 0 ? p.map((d) => d.code).join(",") : null,
          agree: (o.length > 0) === (p.length > 0),
        });
      }
      // Findings on a line with no fixture character on it: the header, or a
      // range that landed a line off.
      const expected = new Set(file.rows.map((row) => row.line));
      for (const [label, side] of [["original", theirs], ["poly", ours]]) {
        for (const d of side.flagged.filter((one) => !expected.has(one.line))) {
          problems.push(`${label} flagged ${file.name}:${d.line + 1}:${d.col + 1}, where no fixture character is`);
        }
      }
    }
    const timing = manifest.typed.files.map((name) => {
      const o = original.typed.find((one) => one.file === name);
      const p = poly.typed.find((one) => one.file === name);
      return {
        file: name,
        language: p.language,
        original: o,
        poly: p,
        agree: o.beforeSave.flagged === p.beforeSave.flagged && o.afterSave.flagged === p.afterSave.flagged,
      };
    });
    const disagreements = rows.filter((row) => !row.agree);
    return {
      summary: {
        characters: manifest.chars.length,
        rows: rows.length,
        disagreements: disagreements.length,
        onlyOriginal: disagreements.filter((row) => row.original).length,
        onlyPoly: disagreements.filter((row) => row.poly).length,
        timingDisagreements: timing.filter((row) => !row.agree).length,
      },
      rows,
      timing,
      problems,
    };
  },
};
