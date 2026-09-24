// One side of the mermaid differential, inside a real extension host.
//
// Which side it is, is decided by what is installed rather than by a flag: the
// built-in `mermaid-markdown-features` is either there -- in which case it owns
// the fences and poly stands down -- or it was disabled on the command line and
// poly owns them. run.js launches this twice and compares the two reports.
//
// Each side is measured in the two places a difference can live:
//
//   * the extension host, where markdown-it decides what a fence becomes. The
//     answer is the HTML the preview would load.
//   * a webview, where mermaid turns that HTML into an SVG. The answer is what
//     the reader sees, so it is measured as geometry and labels rather than as
//     markup: ids, class names and theme colours differ by construction and
//     say nothing about whether the two drew the same picture.
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const vscode = require("vscode");

const { CASES } = require("./cases.js");

const BUILT_IN = "vscode.mermaid-markdown-features";

/** Everything the preview would put on the page for one markdown document. */
async function renderCase(markdown) {
  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: markdown,
  });
  return vscode.commands.executeCommand("markdown.api.render", document);
}

/**
 * The page the webview loads: every case's rendered HTML, in document order.
 *
 * One page rather than one per case, because that is also how a reader meets
 * them -- a document with many diagrams -- and because 40 extension-host round
 * trips to learn the same thing is 40 times the wall clock.
 */
function page(rendered, scriptTag, nonce, csp, probeStale) {
  const sections = rendered
    .map(({ name, html }) => `<section data-case="${name}">\n${html}\n</section>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head>
<body>
${sections}
<script nonce="${nonce}">
  // Before anything renders: what the markdown layer produced. Taken here
  // rather than in the extension host because a DOM is the only honest way to
  // ask "what is the source text inside this container", and both sides spell
  // the container differently.
  //
  // After the sections and before the renderer, which is the only window where
  // this is true. Above them it ran against an empty body and reported nothing
  // for every case -- and nothing compares equal to nothing, so the whole
  // markdown half of the differential silently passed.
  const api = acquireVsCodeApi();
  // The built-in's controls call this too, and a second call throws.
  window.acquireVsCodeApi = () => api;
  // The variables the editor put on the page, read from the stylesheet it
  // injected rather than from a list this file keeps: both renderers ask for
  // names through fallback chains, and when a colour comes out different the
  // question is whether the renderer chose differently or the editor offered
  // something different. Enumerating them answers that without duplicating
  // either renderer's table here, where it would drift.
  //
  // Both places they can live, because where the editor puts them is not
  // documented and this has to hold across the version range: 1.138 sets them
  // as inline style on the root element, and reading only stylesheets found
  // none of them at all.
  window.__vars = {};
  const inline = document.documentElement.style;
  for (const name of inline) {
    if (name.startsWith("--vscode-")) {
      window.__vars[name] = inline.getPropertyValue(name).trim();
    }
  }
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (!rule.style) continue;
      for (const name of rule.style) {
        if (name.startsWith("--vscode-")) {
          window.__vars[name] = rule.style.getPropertyValue(name).trim();
        }
      }
    }
  }
  window.__before = {};
  for (const section of document.querySelectorAll("section[data-case]")) {
    const containers = section.querySelectorAll(".mermaid, .poly-mermaid");
    window.__before[section.dataset.case] = {
      containers: containers.length,
      sources: Array.from(containers, (el) => (el.textContent ?? "").trim()),
      codeFences: section.querySelectorAll("pre > code").length,
      languageClasses: Array.from(
        section.querySelectorAll("pre > code"),
        (el) => el.className.replace(/\\bcode-line\\b|\\s+/g, " ").trim(),
      ),
    };
  }
</script>
${scriptTag}
<script nonce="${nonce}">
  const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason?.message ?? e.reason)));

  const clean = (text) => (text ?? "").replace(/\\s+/g, " ").trim();

  function measure(section) {
    const svg = section.querySelector("svg");
    // Both sides write their failure into the container; the shapes differ, so
    // the question asked is "is there text here that is not a diagram".
    // .mermaid-error is the built-in's failure element and .poly-mermaid-message
    // is poly's. Not [id^=dmermaid]: that is the id mermaid gives the
    // *successful* svg, and matching it here reported every diagram on the
    // built-in's side as a failure. (No backticks in this comment: it lives
    // inside a template literal, and one would end the page here.)
    const errorNode = section.querySelector(".poly-mermaid-message, .mermaid-error");
    const labels = svg
      ? Array.from(svg.querySelectorAll("text, foreignObject div, foreignObject span"))
        .map((el) => clean(el.textContent))
        .filter(Boolean)
      : [];
    const box = svg ? svg.getBoundingClientRect() : null;
    // Interactivity is invisible to geometry. mermaid hands the caller a
    // bindFunctions, and what it binds under securityLevel strict is the node
    // tooltips -- click callbacks are refused at parse time on both sides. A
    // renderer that never calls it draws every shape and label identically and
    // still loses every tooltip, which is what happened here.
    const titled = Array.from(section.querySelectorAll("g.node")).filter((el) => el.hasAttribute("title"));
    let tooltip = "";
    if (titled.length > 0) {
      titled[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      tooltip = clean(document.querySelector(".mermaidTooltip")?.textContent ?? "");
      titled[0].dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    }
    // Every colour the drawing actually uses, as a set rather than a list:
    // the two sides put the same shapes in a different DOM order, so asking
    // "what is the first node's fill" invents differences. What this holds
    // down is the other half of the theme question -- geometry says the same
    // picture was drawn, and this says it was drawn in the same colours,
    // which is the only thing the derived palette can get wrong on its own.
    const palette = svg
      ? [...new Set(
        Array.from(svg.querySelectorAll("*")).flatMap((el) => {
          const style = getComputedStyle(el);
          return [style.fill, style.stroke, style.color];
        }).filter((colour) => colour && colour !== "none"),
      )].sort()
      : [];
    return {
      titles: titled.length,
      tooltip,
      palette,
      svgs: section.querySelectorAll("svg").length,
      shapes: svg ? svg.querySelectorAll("g").length : 0,
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0,
      // Sorted and de-duplicated: the two sides may emit the same labels in a
      // different DOM order without drawing a different picture.
      labels: [...new Set(labels)].sort(),
      failed: Boolean(errorNode) || /Syntax error|Parse error|No diagram type/i.test(section.textContent ?? ""),
      remaining: clean(section.textContent).slice(0, 120),
    };
  }

  // Whether a render that is already running gives way to the one after it.
  //
  // The preview sends its content again on every keystroke, so poly numbers
  // each pass and drops the result of one that has been overtaken. Nothing
  // exercised that: the corpus renders once, and a counter that is never raced
  // is a counter that could be deleted without a test going red.
  //
  // The shape here is the one where the counter is load-bearing, and it took a
  // run with the counter removed to find it. Two details decide whether this
  // measures anything at all:
  //
  //   * the source is edited in place, in the same element. Replacing the
  //     element leaves the older pass holding a node with no parent, and
  //     replaceWith on a detached node does nothing -- so the page came out
  //     right with the counter deleted, and the probe passed for no reason.
  //   * the first source is the quick one and the second is the slow one. The
  //     older pass has to finish first to have anything to corrupt; if it
  //     finishes last, the newer drawing is already in the document and the
  //     older one lands on a detached node again.
  //
  // With those two, an unguarded render leaves the abandoned drawing on screen
  // for good: it replaces the block, and the pass that should have won then
  // finds nothing to replace.
  //
  // poly's side only: the built-in has its own answer to the same problem, and
  // this is about poly's.
  async function raceRenders() {
    const host = document.createElement("section");
    host.dataset.case = "stale-render";
    const block = document.createElement("pre");
    block.className = "poly-mermaid";
    host.append(block);
    document.body.append(host);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Built by concatenation: this lives inside a template literal, so a
    // backtick would end the page and a dollar-brace would be interpolated
    // here in node rather than there in the browser.
    const slow = "graph TD\\n  a[LATEST] --> b0[KEPT 0]\\n"
      + Array.from({ length: 400 }, (_, i) =>
        "  b" + i + "[KEPT " + i + "] --> b" + (i + 1) + "[KEPT " + (i + 1) + "]"
      ).join("\\n");
    const fast = "graph TD\\n  z[STALE] --> y[GONE]";

    block.textContent = fast;
    window.dispatchEvent(new Event("vscode.markdown.updateContent"));
    // No pause before the second keystroke, and none is needed: the listener
    // calls draw synchronously, so by the time dispatch returns the first pass
    // has taken its number and is parked on its first await. Waiting instead
    // means guessing how long a diagram takes -- 40ms and 150 nodes was the
    // first guess, and the probe reported that the render had already landed
    // and nothing raced.
    const raced = host.querySelector("svg") === null;
    block.textContent = slow;
    window.dispatchEvent(new Event("vscode.markdown.updateContent"));
    await wait(15000);

    const svg = host.querySelector("svg");
    // Only the three labels that answer the question: the slow diagram carries
    // hundreds, and none of the rest tells anyone which pass won.
    const labels = svg
      ? [...new Set(
        Array.from(svg.querySelectorAll("text, foreignObject div, foreignObject span"), (el) => clean(el.textContent))
          .filter((label) => label === "LATEST" || label === "STALE" || label === "GONE"),
      )].sort()
      : [];
    const result = { raced, svgs: host.querySelectorAll("svg").length, labels };
    host.remove();
    return result;
  }

  let settled = 0;
  let last = "";
  const timer = setInterval(async () => {
    const now = Array.from(document.querySelectorAll("section[data-case]"))
      .map((s) => s.querySelectorAll("svg").length).join(",");
    // Rendering is asynchronous and per diagram, so the page is done when it
    // stops changing rather than after a fixed wait.
    settled = now === last ? settled + 1 : 0;
    last = now;
    if (settled >= 8) {
      clearInterval(timer);
      const after = {};
      for (const section of document.querySelectorAll("section[data-case]")) {
        after[section.dataset.case] = measure(section);
      }
      const stale = ${probeStale} ? await raceRenders() : null;
      // What the editor actually called this theme. The page does not set it:
      // both renderers decide light from dark by reading it, so a suite that
      // wrote it would be handing them the answer -- and one that never
      // changed it would compare four identical measurements and call it
      // agreement across four themes.
      api.postMessage({
        before: window.__before,
        after,
        pageErrors: errors,
        bodyClass: document.body.className,
        vars: window.__vars,
        stale,
      });
    }
  }, 250);
</script>
</body>
</html>`;
}

/**
 * The themes to measure, and why more than one.
 *
 * poly derives mermaid's colours from `--vscode-*` through a table of fallback
 * lists, and which entry in a list answers depends on the theme: a variable a
 * dark theme defines may be absent from a light one, so the same table can send
 * the two renderers to different colours without anything in the dark
 * measurement moving. Four kinds because that is how many the editor has -- the
 * two high-contrast ones are separate themes, not a dark theme with more
 * contrast.
 */
const THEMES = (process.env.POLY_MERMAID_THEMES ?? "Default Dark Modern").split(",");

/** Everything one theme's page reports, from a webview of its own. */
async function measureTheme(theme, rendered, side, builtIn) {
  await vscode.workspace.getConfiguration("workbench").update(
    "colorTheme",
    theme,
    vscode.ConfigurationTarget.Global,
  );
  // The panel is created after the update so it opens into the new theme;
  // the editor still needs a moment to push the variables down to webviews.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const editorDist = join(process.env.POLY_EXTENSION_ROOT, "dist");
  const roots = [vscode.Uri.file(editorDist)];
  if (builtIn) {
    roots.push(vscode.Uri.file(builtIn.extensionPath));
  }
  const panel = vscode.window.createWebviewPanel(
    "polyMermaidDiff",
    `mermaid diff (${side})`,
    vscode.ViewColumn.One,
    { enableScripts: true, localResourceRoots: roots, retainContextWhenHidden: true },
  );

  const nonce = "mermaid-diff-nonce";
  const source = panel.webview.cspSource;
  // The markdown preview's own policy, copied so that a difference in what the
  // two scripts are allowed to do shows up here rather than in someone's editor.
  const csp = `default-src 'none'; style-src ${source} 'unsafe-inline'; font-src ${source}; `
    + `img-src ${source} https: data:; media-src ${source} https: data:; `
    + `script-src 'nonce-${nonce}' ${source}; worker-src ${source} blob:; connect-src ${source};`;

  const scriptTag = builtIn
    ? `<script type="module" src="${
      panel.webview.asWebviewUri(
        vscode.Uri.file(join(builtIn.extensionPath, "markdown-preview-out", "index.js")),
      )
    }"></script>`
    : `<script src="${panel.webview.asWebviewUri(vscode.Uri.file(join(editorDist, "preview.js")))}"></script>`;

  panel.webview.html = page(rendered, scriptTag, nonce, csp, !builtIn);

  const measured = await new Promise((resolve) => {
    panel.webview.onDidReceiveMessage(resolve);
    setTimeout(() => resolve({ timedOut: true, before: {}, after: {}, pageErrors: [] }), 180000);
  });
  panel.dispose();

  return {
    bodyClass: measured.bodyClass ?? "",
    stale: measured.stale ?? null,
    vars: measured.vars ?? {},
    cases: Object.fromEntries(
      rendered.map(({ name, group }) => [name, {
        group,
        ...(measured.before[name] ?? {}),
        ...(measured.after[name] ?? {}),
      }]),
    ),
    pageErrors: measured.pageErrors,
    timedOut: Boolean(measured.timedOut),
  };
}

exports.run = async function run() {
  const builtIn = vscode.extensions.getExtension(BUILT_IN);
  const side = builtIn ? "built-in" : "poly";
  await vscode.extensions.getExtension("ricky.poly-lsp").activate();
  await builtIn?.activate();

  // Once, outside the theme loop: what markdown-it makes of a fence does not
  // depend on the colours, and 74 renders per theme is three times the wall
  // clock for the same HTML.
  const rendered = [];
  for (const one of CASES) {
    rendered.push({ name: one.name, group: one.group, html: await renderCase(one.markdown) });
  }

  const themes = {};
  for (const theme of THEMES) {
    themes[theme] = await measureTheme(theme, rendered, side, builtIn);
    console.log(`${side}: measured ${Object.keys(themes[theme].cases).length} cases in ${theme}`);
  }

  const report = { side, vscode: vscode.version, themes };
  writeFileSync(process.env.POLY_MERMAID_OUT, `${JSON.stringify(report, null, 2)}\n`);
};
