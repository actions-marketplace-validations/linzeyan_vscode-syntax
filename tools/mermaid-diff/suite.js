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
function page(rendered, scriptTag, nonce, csp) {
  const sections = rendered
    .map(({ name, html }) => `<section data-case="${name}">\n${html}\n</section>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head>
<body class="vscode-dark">
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
    return {
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

  let settled = 0;
  let last = "";
  const timer = setInterval(() => {
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
      api.postMessage({ before: window.__before, after, pageErrors: errors });
    }
  }, 250);
</script>
</body>
</html>`;
}

exports.run = async function run() {
  const builtIn = vscode.extensions.getExtension(BUILT_IN);
  const side = builtIn ? "built-in" : "poly";
  await vscode.extensions.getExtension("ricky.poly-editor").activate();
  await builtIn?.activate();

  const rendered = [];
  for (const one of CASES) {
    rendered.push({ name: one.name, group: one.group, html: await renderCase(one.markdown) });
  }

  const editorDist = join(process.env.POLY_EDITOR_DIST, "dist");
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
    : `<script src="${
      panel.webview.asWebviewUri(vscode.Uri.file(join(editorDist, "preview.js")))
    }"></script>`;

  panel.webview.html = page(rendered, scriptTag, nonce, csp);

  const measured = await new Promise((resolve) => {
    panel.webview.onDidReceiveMessage(resolve);
    setTimeout(() => resolve({ timedOut: true, before: {}, after: {}, pageErrors: [] }), 180000);
  });
  panel.dispose();

  const report = {
    side,
    vscode: vscode.version,
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
  writeFileSync(process.env.POLY_MERMAID_OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${side}: measured ${Object.keys(report.cases).length} cases`);
};
