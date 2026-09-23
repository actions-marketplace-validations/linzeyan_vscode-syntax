// One side of one case set, inside a real extension host.
//
// Which side it is and what it must hold is told by run.js rather than
// discovered: an original that failed to install and a poly extension that
// failed to load both look like "this side flagged nothing", and nothing
// compares equal to nothing. So the first thing this does is prove the side is
// the side it claims to be, and it writes that proof into the results next to
// every answer it goes on to collect.
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const vscode = require("vscode");

const cdp = require("./cdp");

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The diagnostics `keep` accepts on `uri`, once they have arrived and stopped
 * changing -- or nothing, once `first` has passed without any.
 *
 * Driven by `onDidChangeDiagnostics` rather than by polling, and quiet-period
 * rather than first-event: poly publishes once per lint, but a linter that
 * reports in two batches would otherwise be read half-way. The timeout is the
 * only way to learn "never": a side that does not lint this file sends no
 * event to wait for.
 *
 * `ms` is when the first matching diagnostic appeared, measured from the call,
 * so a caller that starts the clock at an edit learns how long the user would
 * have looked at an unflagged character.
 */
function settleDiagnostics(uri, keep, { first = 20_000, quiet = 600 } = {}) {
  const started = Date.now();
  const read = () => vscode.languages.getDiagnostics(uri).filter(keep);
  return new Promise((resolve) => {
    let seenAt = read().length > 0 ? Date.now() : null;
    let quietTimer;
    const finish = (timedOut) => {
      subscription.dispose();
      clearTimeout(quietTimer);
      clearTimeout(deadline);
      resolve({ diagnostics: read(), ms: seenAt === null ? null : seenAt - started, timedOut });
    };
    const arm = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(false), quiet);
    };
    const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      if (!event.uris.some((one) => one.toString() === uri.toString())) return;
      if (read().length > 0) {
        seenAt ??= Date.now();
        arm();
      }
    });
    const deadline = setTimeout(() => finish(true), first);
    if (seenAt !== null) arm();
  });
}

/**
 * `probe()`'s answer once `done(answer)` holds and has held for `stable`
 * consecutive asks, or the last answer at the deadline.
 *
 * For the questions that have no event: a code lens list, a document symbol
 * list. Held rather than first-seen, because both grow -- a language server
 * reports what it has parsed so far.
 */
async function until(probe, done, { timeout = 30_000, every = 300, stable = 3 } = {}) {
  const deadline = Date.now() + timeout;
  let answer;
  let held = 0;
  let previous;
  while (Date.now() < deadline) {
    answer = await probe();
    const key = JSON.stringify(answer);
    held = done(answer) && key === previous ? held + 1 : done(answer) ? 1 : 0;
    previous = key;
    if (held >= stable) return { answer, timedOut: false };
    await wait(every);
  }
  return { answer, timedOut: true };
}

/** Open `uri` in the one editor group, with nothing else beside it. */
async function openAlone(uri) {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const document = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
}

exports.run = async function run() {
  const setId = process.env.POLY_EXT_DIFF_SET;
  const side = process.env.POLY_EXT_DIFF_SIDE;
  const out = process.env.POLY_EXT_DIFF_OUT;
  const expect = JSON.parse(process.env.POLY_EXT_DIFF_EXPECT);
  const set = require(`./sets/${setId}.js`);
  const manifest = JSON.parse(readFileSync(join(out, "..", "manifest.json"), "utf8"));

  const report = { set: setId, side, vscode: vscode.version, extensions: [], shots: [] };
  let screen;
  let problemsFiltered = false;
  try {
    // Activated by hand rather than left to their events: an activation event
    // that did not fire is one more way for a side to answer nothing.
    for (const id of expect.present) {
      const extension = vscode.extensions.getExtension(id);
      if (!extension) throw new Error(`${id} is not installed on the ${side} side`);
      await extension.activate();
    }
    for (const id of expect.absent) {
      if (vscode.extensions.getExtension(id)) {
        throw new Error(`${id} is loaded on the ${side} side, so its answers would be mixed into this one`);
      }
    }
    report.extensions = vscode.extensions.all
      .filter((one) => !one.packageJSON.isBuiltin && !one.id.startsWith("vscode."))
      .map((one) => `${one.id}@${one.packageJSON.version}`)
      .sort();

    screen = await cdp.connect(Number(process.env.POLY_EXT_DIFF_CDP));
    // Chrome that is not part of either side's answer, closed so the pictures
    // hold the editor and the panel the case is about.
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => {});
    await vscode.commands.executeCommand("notifications.clearAll");

    const ctx = {
      vscode,
      side,
      out,
      manifest,
      folder: vscode.workspace.workspaceFolders[0].uri,
      wait,
      until,
      settleDiagnostics,
      openAlone,
      screen,
      /**
       * The Problems panel, showing only the active file's findings whose
       * text matches `filter`. Other linters' findings are real and a user
       * sees them, but seventy markdown-style warnings push the ones this case
       * is about out of the picture.
       */
      async problems(filter) {
        await vscode.commands.executeCommand("workbench.actions.view.problems");
        if (!problemsFiltered) {
          await vscode.commands.executeCommand("workbench.actions.workbench.panel.markers.view.toggleActiveFile");
          problemsFiltered = true;
        }
        await vscode.commands.executeCommand("problems.action.clearFilterText");
        if (filter) {
          await vscode.commands.executeCommand("problems.action.focusFilter");
          await screen.insertText(filter);
          // The view filters on a delay after the last keystroke, and the
          // first picture of the first run was taken inside it: 70 markdown
          // findings under a filter box that said "unicode". Its badge is the
          // signal -- "Showing N of M" appears once the filter has applied --
          // and it never appears when every row matches, hence the bound.
          await screen.evaluate(`new Promise((done) => {
            const started = Date.now();
            (function tick() {
              const badge = document.querySelector(".viewpane-filter-badge");
              if ((badge && !badge.classList.contains("hidden")) || Date.now() - started > 2000) return done();
              setTimeout(tick, 50);
            })();
          })`);
        }
      },
      /**
       * The code lenses the editor actually drew, top to bottom, once `want`
       * of them are on screen or `timeout` has passed.
       *
       * Not the same question as `executeCodeLensProvider`. That asks the
       * providers again, now, and a provider that answered nothing when the
       * file opened answers fine by the time a test asks -- while the editor,
       * which asked once at open and was never told to ask again, shows
       * nothing. The first shell run had JSON full of `2 refs` over a
       * screenshot with no lens in it.
       */
      async renderedLenses(want, timeout = 8_000) {
        const read = () =>
          screen.evaluate(`[...document.querySelectorAll(".monaco-editor .codelens-decoration")]
            .map((zone) => ({ top: parseFloat(zone.style.top || "0"), text: zone.textContent.replace(/\\u00a0/g, " ").trim() }))
            .sort((a, b) => a.top - b.top)
            .map((zone) => zone.text)`);
        const settled = await until(read, (texts) => texts.length >= want, { timeout, every: 250, stable: 2 });
        return settled.answer ?? [];
      },
      /**
       * Take one picture, named for what it shows; `caption` goes in the
       * report. A picture that cannot be taken is written down rather than
       * thrown: the JSON is the result, and the picture is its illustration.
       */
      async shot(name, caption) {
        await vscode.commands.executeCommand("notifications.clearAll");
        const file = `${name}.png`;
        try {
          // Two frames: one for whatever the host just handed the renderer, one
          // for the paint after it. Raced against a timer, because a hidden
          // window runs no animation frames at all.
          await screen.evaluate(
            "new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 1000); })",
          );
          await screen.screenshot(join(out, file));
          report.shots.push({ name, file, caption });
        } catch (error) {
          report.shots.push({ name, file: null, caption, error: String(error.message ?? error) });
        }
      },
    };
    Object.assign(report, await set.observe(ctx));
  } catch (error) {
    report.error = String(error && error.stack ? error.stack : error);
  } finally {
    screen?.close();
    writeFileSync(join(out, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.error) {
    throw new Error(`${setId}/${side}: ${report.error}`);
  }
  console.log(`${setId}/${side}: ${report.shots.length} screenshots, results in ${out}`);
};
