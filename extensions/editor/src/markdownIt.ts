/**
 * The two ways a markdown document says "this is a diagram".
 *
 * A ```mermaid fence, and a `:::mermaid` container. Both are what the built-in
 * `mermaid-markdown-features` accepts, and this file exists to accept exactly
 * the same two -- a document that draws on VSCode 1.135 has to draw on 1.120,
 * or poly is not standing in for it, it is a second thing with its own rules.
 *
 * No `vscode` import: the editor's answers arrive as the `renders` predicate,
 * which is asked per render rather than once, so the setting and the presence
 * of the built-in can both change while a preview is open.
 */
import { isMermaidContainer, isMermaidFence, mermaidBlock } from "./mermaid";

/** As much of a markdown-it token as the rules below touch. */
interface Token {
  info: string;
  content: string;
  markup: string;
  block: boolean;
  map: [number, number] | null;
}

type Rule = (
  tokens: readonly Token[],
  index: number,
  options: unknown,
  env: unknown,
  self: { renderToken(tokens: readonly Token[], index: number, options: unknown): string },
) => string;

/** As much of markdown-it's block parser state as the container rule reads. */
interface BlockState {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  line: number;
  lineMax: number;
  parentType: string;
  skipSpaces(pos: number): number;
  getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
  push(type: string, tag: string, nesting: number): Token;
}

export interface MarkdownIt {
  renderer: { rules: Record<string, Rule | undefined> };
  block: {
    ruler: {
      before(
        beforeName: string,
        ruleName: string,
        rule: (state: BlockState, startLine: number, endLine: number, silent: boolean) => boolean,
        options?: { alt: string[] },
      ): void;
    };
  };
}

/** The token type the container rule emits, and the renderer rule that draws it. */
const CONTAINER = "poly_mermaid_container";

const COLON = 0x3a;

/** How many colons open a container, and how deep an indent stops being one. */
const MIN_MARKER = 3;
const CODE_INDENT = 4;

/**
 * `:::mermaid` … `:::`, as a block rule.
 *
 * A port of the built-in's, down to the line scanning, because the edges are
 * where two implementations of "the same" syntax stop agreeing: a closing run
 * has to be at least as long as the opening one, four spaces of indent make it
 * a code block instead, and a container that reaches the end of the document
 * without a closing line still closes.
 *
 * Registered before `fence` so that `:::` wins over a paragraph, with the same
 * `alt` list the built-in uses -- that is what lets one appear inside a list
 * item or a blockquote.
 */
function containerRule(
  renders: () => boolean,
): (state: BlockState, startLine: number, endLine: number, silent: boolean) => boolean {
  return (state, startLine, endLine, silent) => {
    if (!renders()) {
      return false;
    }
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.src.charCodeAt(start) !== COLON) {
      return false;
    }
    let pos = start + 1;
    while (pos <= max && state.src.charCodeAt(pos) === COLON) {
      pos += 1;
    }
    const marker = pos - start;
    if (marker < MIN_MARKER) {
      return false;
    }
    if (!isMermaidContainer(state.src.slice(pos, max))) {
      return false;
    }
    // `silent` is markdown-it asking whether this line *could* open a block,
    // during a lookahead that must not produce tokens.
    if (silent) {
      return true;
    }

    let nextLine = startLine;
    let closed = false;
    for (;;) {
      nextLine += 1;
      if (nextLine >= endLine) {
        break;
      }
      const from = state.bMarks[nextLine] + state.tShift[nextLine];
      const to = state.eMarks[nextLine];
      if (from < to && state.sCount[nextLine] < state.blkIndent) {
        // A non-empty line outdented past the block: the container ends here
        // whether or not anybody wrote the closing colons.
        break;
      }
      if (state.src.charCodeAt(from) !== COLON) {
        continue;
      }
      if (state.sCount[nextLine] - state.blkIndent >= CODE_INDENT) {
        continue;
      }
      let end = from + 1;
      while (end <= to && state.src.charCodeAt(end) === COLON) {
        end += 1;
      }
      if (end - from < marker) {
        continue;
      }
      if (state.skipSpaces(end) < to) {
        continue; // trailing content, so not a closing line
      }
      closed = true;
      break;
    }

    const parentType = state.parentType;
    const lineMax = state.lineMax;
    state.parentType = "container";
    state.lineMax = nextLine;
    const token = state.push(CONTAINER, "div", 1);
    token.markup = state.src.slice(start, pos);
    token.block = true;
    token.info = state.src.slice(pos, max);
    token.map = [startLine, nextLine];
    token.content = state.getLines(startLine + 1, nextLine, state.blkIndent, true);
    state.parentType = parentType;
    state.lineMax = lineMax;
    state.line = nextLine + (closed ? 1 : 0);
    return true;
  };
}

/**
 * Teach one markdown-it instance both shapes.
 *
 * The fence rule falls through to whatever was there before rather than to a
 * default of its own: another extension may have wrapped it first, and the
 * languages this does not claim have to come out exactly as they would have.
 */
export function mermaidPlugin(renders: () => boolean): (md: MarkdownIt) => MarkdownIt {
  return (md) => {
    const previous = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, index, options, env, self) => {
      const token = tokens[index];
      if (renders() && isMermaidFence(token.info)) {
        return mermaidBlock(token.content);
      }
      return previous
        ? previous(tokens, index, options, env, self)
        : self.renderToken(tokens, index, options);
    };

    md.block.ruler.before("fence", CONTAINER, containerRule(renders), {
      alt: ["paragraph", "reference", "blockquote", "list"],
    });
    md.renderer.rules[CONTAINER] = (tokens, index) => mermaidBlock(tokens[index].content);
    return md;
  };
}
