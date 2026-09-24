/**
 * Drawing the diagram, inside the markdown preview's webview.
 *
 * The extension host cannot do this: mermaid measures the text it lays out, so
 * it needs a DOM, and the only DOM in a preview is the webview's. This file is
 * therefore a second bundle with a second tsconfig -- `dist/preview.js`, loaded
 * through `contributes.markdown.previewScripts` -- and the only thing it shares
 * with the extension is the class name `../mermaid.ts` emits.
 *
 * It renders nothing unless that class is on the page, which is how it stays
 * quiet on VSCode 1.135 and later: there the extension host leaves the fence to
 * the built-in `mermaid-markdown-features` and never emits the class at all.
 */
import tidyTreeLayout from "@mermaid-js/layout-tidy-tree";
import mermaid from "mermaid";

import { MERMAID_CLASS } from "../mermaid";
import { editorTheme } from "./theme";

// mermaid resolves a `click X "url"` through `URL.canParse`, which Chromium
// only grew in 120. VSCode 1.85 -- the floor `engines.vscode` claims -- ships
// an older one, and measured there every diagram carrying a click directive
// failed to draw at all, not just the link. Three lines is cheaper than
// raising the floor for one directive, and it is inert everywhere newer.
const urlStatics = URL as unknown as {
  canParse?: (url: string, base?: string) => boolean;
};
urlStatics.canParse ??= (url, base) => {
  try {
    void new URL(url, base);
    return true;
  } catch {
    return false;
  }
};

// The one extra layout the built-in registers that poly can also carry: MIT,
// 242 KB, and its only dependency is the d3 already in this bundle. The other
// one is ELK, whose `elkjs` is EPL-2.0 -- `layout: elk` therefore still falls
// back to dagre here, which mermaid does with a warning rather than an error.
mermaid.registerLayoutLoaders(tidyTreeLayout);

/**
 * What the reader sees when the markup does not parse.
 *
 * The source stays on screen and the message goes under it. mermaid's own
 * answer to a parse error is to replace the diagram with a picture of a bomb,
 * which says less than the text that failed -- `suppressErrorRendering` turns
 * that off, and this replaces it.
 */
function failure(source: string, error: unknown): HTMLElement {
  const block = document.createElement("pre");
  block.className = `${MERMAID_CLASS} ${MERMAID_CLASS}-error`;
  block.textContent = source;
  const message = document.createElement("div");
  message.className = `${MERMAID_CLASS}-message`;
  message.textContent = error instanceof Error ? error.message : String(error);
  block.append(message);
  return block;
}

/**
 * The render that is allowed to finish.
 *
 * The preview re-renders its whole body on every keystroke, so a render started
 * for the previous body can land after the DOM it was drawing into is gone.
 * Each pass takes a number and drops its result if a later pass has started.
 */
let generation = 0;

async function draw(): Promise<void> {
  const mine = ++generation;
  const blocks = Array.from(
    document.querySelectorAll<HTMLElement>(`pre.${MERMAID_CLASS}:not(.${MERMAID_CLASS}-error)`),
  );
  if (blocks.length === 0) {
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    // Read on every pass rather than once: the preview does not reload when the
    // colour theme changes, it re-sends its content, and that arrives here.
    ...editorTheme(),
    // The preview is not a trusted document: it renders whatever markdown the
    // workspace contains, which is why the source was escaped on the way in.
    securityLevel: "strict",
    suppressErrorRendering: true,
  });
  for (const [index, block] of blocks.entries()) {
    const source = (block.textContent ?? "").trim();
    // An empty fence draws nothing and says nothing. mermaid answers "" with
    // "No diagram type detected", which is a complaint about a document that
    // has not been written yet -- and the fence is empty for every keystroke it
    // takes to write the first word.
    if (source === "") {
      continue;
    }
    try {
      // The id is what mermaid names the temporary element it measures in, so
      // it has to differ per diagram and per pass.
      const { svg, bindFunctions } = await mermaid.render(
        `${MERMAID_CLASS}-${mine}-${index}`,
        source,
      );
      if (mine !== generation) {
        return;
      }
      const host = document.createElement("div");
      host.className = MERMAID_CLASS;
      host.innerHTML = svg;
      // mermaid writes a `height` that can disagree with its own viewBox -- a
      // journey diagram's is 25px taller than the box it draws -- and it pins
      // the height while the `max-width` it also writes lets the width follow a
      // narrowing preview, so the diagram letterboxes instead of scaling. The
      // viewBox is the honest size, and dropping the attribute where there is
      // one is what the built-in does.
      const drawn = host.querySelector("svg");
      if (drawn?.hasAttribute("viewBox")) {
        drawn.removeAttribute("height");
      }
      block.replaceWith(host);
      // The svg is only half of what a render produces. The other half is this,
      // and under `securityLevel: "strict"` what it binds is the node tooltips
      // -- a `click` callback is refused when the source is parsed, but a
      // tooltip is attached here or not at all. Called after the host is in the
      // document, because it selects inside what it is given and positions the
      // tooltip from a layout that does not exist until then.
      bindFunctions?.(host);
    } catch (error) {
      if (mine !== generation) {
        return;
      }
      block.replaceWith(failure(source, error));
    }
  }
}

// Both, and in this order: the content is already on the page when the script
// first runs, and every later edit arrives as this event.
window.addEventListener("vscode.markdown.updateContent", () => {
  void draw();
});
void draw();
