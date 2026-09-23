// poly's References tree against the editor's own references-view.
//
// The one set whose reference is not a marketplace extension: clicking poly's
// `N refs` lens opens poly's own tree, and what that replaced -- for anyone
// who clicked a count before -- is `references-view`, which ships inside the
// editor. Both are asked about the same name in the same TypeScript fixture,
// and both answers come from the same provider, so a difference is in the
// presentation: which hits are listed, and what each row says.
//
// The rows are read out of the rendered tree rather than out of either
// extension, because a row is what a person reads: a tree provider can hold a
// hit and still not show it, and the built-in view has no API to ask.
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const FILES = {
  "shapes.ts": `export function area(width: number, height: number): number {
  return width * height;
}
`,
  "use.ts": `import { area } from "./shapes";

export const small = area(1, 2);
export const large = area(10, 20);

export function total(): number {
  return area(3, 4) + small + large;
}
`,
};

/** Where `area` is declared: the position both sides are asked about. */
const TARGET = { file: "shapes.ts", line: 0, col: "export function ".length };

/** Every tree pane in the workbench with rows in it, as the renderer drew it. */
const READ_TREES = `(() => {
  const found = [];
  for (const pane of document.querySelectorAll(".pane")) {
    const rows = [...pane.querySelectorAll(".pane-body .monaco-list-row")].map((row) => ({
      label: row.querySelector(".label-name")?.textContent ?? "",
      description: row.querySelector(".label-description")?.textContent ?? "",
      aria: row.getAttribute("aria-label") ?? "",
      level: Number(row.getAttribute("aria-level") ?? 0),
      expanded: row.getAttribute("aria-expanded"),
      text: row.textContent.trim(),
    }));
    if (rows.length === 0) continue;
    found.push({
      title: pane.querySelector(".pane-header .title")?.textContent?.trim() ?? "",
      container: pane.closest("[id^='workbench.view'], [id^='workbench.panel']")?.id ?? "",
      rows,
    });
  }
  return found;
})()`;

module.exports = {
  id: "refview",
  title: "poly's References tree vs the built-in references-view",
  builtin: "vscode.references-view",

  settings(side) {
    return side === "poly" ? { "poly.referencesCodeLens.enabled": true } : {};
  },

  fixture(workspace) {
    for (const [name, text] of Object.entries(FILES)) writeFileSync(join(workspace, name), text);
    return { target: TARGET, files: FILES };
  },

  async observe(ctx) {
    const { vscode, side, manifest, folder, screen } = ctx;
    const where = (location) =>
      `${vscode.workspace.asRelativePath(location.uri)}:${location.range.start.line + 1}:${
        location.range.start.character + 1
      }`;
    const uri = vscode.Uri.joinPath(folder, manifest.target.file);
    // use.ts opened once first, so the TypeScript project holds both files
    // before anyone asks who calls `area`.
    await ctx.openAlone(vscode.Uri.joinPath(folder, "use.ts"));
    const editor = await ctx.openAlone(uri);
    const position = new vscode.Position(manifest.target.line, manifest.target.col);
    const ready = await ctx.until(
      async () => (await vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, position) ?? []).length,
      (count) => count > 1,
      { timeout: 60_000 },
    );
    const locations = (await vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, position) ?? [])
      .map(where)
      .sort();

    let lens = null;
    if (side === "poly") {
      const lenses = await ctx.until(
        async () =>
          (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri, 100) ?? [])
            .filter((one) => one.range.start.line === manifest.target.line && /refs?$/.test(one.command?.title ?? ""))
            .map((one) => ({
              title: one.command.title,
              command: one.command.command,
              arguments: one.command.arguments,
            })),
        (list) => list.length > 0,
        { timeout: 30_000 },
      );
      const found = lenses.answer?.[0];
      if (!found) throw new Error("no reference lens appeared over `area`, so there was nothing to click");
      // Clicked through the API whether or not the editor drew it -- the tree
      // is the question here -- but whether a user could have clicked it is
      // written down beside it.
      lens = { title: found.title, command: found.command, onScreen: await ctx.renderedLenses(1) };
      // The click, exactly as the editor performs it: the lens's own command
      // with the lens's own arguments.
      await vscode.commands.executeCommand(found.command, ...(found.arguments ?? []));
    } else {
      editor.selection = new vscode.Selection(position, position);
      await vscode.commands.executeCommand("references-view.findReferences");
    }

    // The tree fills asynchronously on both sides -- poly fetches an outline
    // per file to label the rows -- so the answer is the row list once it
    // stops changing.
    const pick = (trees) =>
      side === "poly"
        ? trees.find((tree) => /^references$/i.test(tree.title) && tree.container.includes("explorer"))
        : trees.find((tree) => tree.container.includes("references-view"));
    // Settled on "a file row and a hit under it": references-view draws only
    // the first file open, so waiting for every hit would wait out the clock.
    const trees = await ctx.until(
      async () => pick(await screen.evaluate(READ_TREES)) ?? null,
      (tree) => tree !== null && tree.rows.some((row) => row.level > 1),
      { timeout: 20_000 },
    );
    // What the tree says it holds, where the loaded source can say: the
    // command arrived after this harness was written, so its absence is
    // recorded rather than treated as a failure.
    let shown = null;
    if (side === "poly" && (await vscode.commands.getCommands(true)).includes("poly.referencesShown")) {
      shown = await vscode.commands.executeCommand("poly.referencesShown");
    }
    await ctx.shot(
      "references",
      side === "poly"
        ? `after clicking poly's "${lens.title}" lens over \`area\``
        : "after references-view.findReferences at `area`",
    );
    return {
      referencesReady: !ready.timedOut,
      locations,
      lens,
      tree: trees.answer,
      treeTimedOut: trees.timedOut,
      shown,
      // Everything the renderer drew, for the case where `pick` chose wrong.
      allTrees: await screen.evaluate(READ_TREES),
    };
  },

  diff(original, poly, manifest) {
    const problems = [];
    if (original.locations.join() !== poly.locations.join()) {
      problems.push(
        "the reference provider answered differently on the two sides, so the trees are not showing the same question",
      );
    }
    for (const side of [original, poly]) {
      if (!side.tree) problems.push(`${side.side}: no references tree was found on screen`);
    }
    /** The drawn tree as files, each with its hit rows and whether it was open. */
    const byFile = (tree) => {
      const files = new Map();
      let current = null;
      for (const row of tree?.rows ?? []) {
        if (row.level === 1) {
          current = { expanded: row.expanded === "true", hits: [] };
          files.set(row.label, current);
        } else if (current) {
          current.hits.push(row);
        }
      }
      return files;
    };
    const theirs = byFile(original.tree);
    const ours = byFile(poly.tree);
    // One row per location the provider returned, which is what both trees
    // were handed. Each tree is then asked whether it drew that hit: poly by
    // the line number it prints, references-view by the source it previews --
    // it prints no number, which is the difference poly's tree was built for.
    const rows = original.locations.map((location) => {
      const [file, line] = location.split(":");
      const source = manifest.files[file].split("\n")[Number(line) - 1].trim();
      const o = theirs.get(file);
      const p = ours.get(file);
      const drawnThere = o?.hits.find((row) => row.label.trim() && source.includes(row.label.trim()));
      const drawnHere = p?.hits.find((row) => new RegExp(`^${line}\\s`).test(row.label));
      const status = (tree, hit) => (hit ? "drawn" : tree && !tree.expanded ? "under a collapsed file" : "not listed");
      return {
        location,
        source,
        referencesView: status(o, drawnThere),
        polyTree: status(p, drawnHere),
        polyRow: drawnHere ? `${drawnHere.label}${drawnHere.description ? `  [${drawnHere.description}]` : ""}` : null,
        agree: Boolean(drawnThere) === Boolean(drawnHere),
      };
    });
    const target = `${manifest.target.file}:${manifest.target.line + 1}:${manifest.target.col + 1}`;
    return {
      summary: {
        locations: original.locations.length,
        referencesViewHitsDrawn: rows.filter((row) => row.referencesView === "drawn").length,
        polyTreeHitsDrawn: rows.filter((row) => row.polyTree === "drawn").length,
        polyLens: poly.lens?.title ?? null,
        polyLensOnScreen: poly.lens?.onScreen?.join(" | ") || null,
        rowDisagreements: rows.filter((row) => !row.agree).length,
        polyShownCommand: poly.shown === null ? "not registered by the loaded poly-editor" : "read",
      },
      notes: [
        `both sides asked at ${target} (\`area\`); the location list is the reference provider's answer, the rows are what each tree drew.`,
      ],
      rows,
      locations: original.locations.map((location, index) => ({
        original: location,
        poly: poly.locations[index] ?? null,
        agree: location === poly.locations[index],
      })),
      problems,
    };
  },
};
