/**
 * The mermaid theme the editor's own colours describe.
 *
 * mermaid's stock themes know nothing about VSCode: a diagram drawn with them
 * sits in the preview as a foreign object, its own palette on the editor's
 * background and its own Trebuchet at 16px against the preview's font. The
 * built-in `mermaid-markdown-features` answers this by handing mermaid's `base`
 * theme the `--vscode-*` variables, and this maps the same variables onto the
 * same theme keys -- measured against it, because the font decides how wide a
 * label is and so a document that differs here differs in its geometry too, not
 * just in its colour.
 */

type ThemeVariables = Record<string, string | boolean>;

/**
 * Whether the preview is drawing a dark theme.
 *
 * The preview marks its theme on `<body>`, and it is the only signal here: a
 * webview cannot read `workbench.colorTheme`. `vscode-high-contrast` is the
 * dark high-contrast theme; the light one is `vscode-high-contrast-light`, and
 * it carries both classes, so it is excluded by name.
 */
export function isDarkTheme(): boolean {
  const classes = document.body.classList;
  return classes.contains("vscode-dark")
    || (classes.contains("vscode-high-contrast") && !classes.contains("vscode-high-contrast-light"));
}

/** Which editor colours answer for one mermaid theme key, in fallback order. */
const COLORS: ReadonlyArray<readonly [string, ...string[]]> = [
  ["background", "--vscode-editor-background"],
  ["textColor", "--vscode-charts-foreground", "--vscode-editor-foreground", "--vscode-foreground"],
  ["lineColor", "--vscode-chart-line", "--vscode-charts-lines", "--vscode-editor-foreground", "--vscode-foreground"],
  ["primaryColor", "--vscode-editorWidget-background"],
  ["primaryTextColor", "--vscode-charts-foreground", "--vscode-editor-foreground", "--vscode-foreground"],
  ["primaryBorderColor", "--vscode-chart-line", "--vscode-editorWidget-border", "--vscode-focusBorder"],
  ["mainBkg", "--vscode-editorWidget-background"],
  ["nodeBorder", "--vscode-chart-line", "--vscode-editorWidget-border", "--vscode-focusBorder"],
  ["secondaryColor", "--vscode-input-background", "--vscode-editorWidget-background"],
  ["secondaryTextColor", "--vscode-input-foreground", "--vscode-foreground"],
  ["secondaryBorderColor", "--vscode-input-border", "--vscode-editorWidget-border"],
  ["tertiaryColor", "--vscode-textBlockQuote-background", "--vscode-input-background"],
  ["tertiaryTextColor", "--vscode-foreground"],
  ["tertiaryBorderColor", "--vscode-textBlockQuote-border", "--vscode-editorWidget-border"],
  ["clusterBkg", "--vscode-textBlockQuote-background", "--vscode-input-background"],
  ["clusterBorder", "--vscode-textBlockQuote-border", "--vscode-editorWidget-border"],
  ["noteBkgColor", "--vscode-textBlockQuote-background", "--vscode-editorWidget-background"],
  ["noteTextColor", "--vscode-foreground"],
  ["noteBorderColor", "--vscode-textBlockQuote-border", "--vscode-editorWidget-border"],
  ["errorBkgColor", "--vscode-inputValidation-errorBackground", "--vscode-editorError-background"],
  ["errorTextColor", "--vscode-editorError-foreground", "--vscode-foreground"],
  ["titleColor", "--vscode-charts-foreground", "--vscode-editor-foreground", "--vscode-foreground"],
  ["edgeLabelBackground", "--vscode-editor-background"],
];

/** The series colours, for the diagrams that draw one shape per datum. */
const CHART_PALETTE: readonly string[] = [
  "--vscode-charts-blue",
  "--vscode-charts-green",
  "--vscode-charts-orange",
  "--vscode-charts-red",
  "--vscode-charts-purple",
  "--vscode-charts-yellow",
];

function readCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const RGB = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/;

function toHex(color: string): string | undefined {
  const parts = RGB.exec(color);
  if (!parts) {
    return undefined;
  }
  const channel = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  const rgb = `${channel(Number(parts[1]))}${channel(Number(parts[2]))}${channel(Number(parts[3]))}`;
  const alpha = parts[4] === undefined ? 255 : Math.round(Number.parseFloat(parts[4]) * 255);
  return alpha < 255 ? `#${rgb}${channel(alpha)}` : `#${rgb}`;
}

/**
 * The first of these variables that names a colour, as hex.
 *
 * Resolved by laying the value on a throwaway element rather than by parsing
 * it, because a theme may write any CSS colour -- `rgba()`, a name, another
 * `var()` -- and mermaid's palette arithmetic only takes hex.
 */
function pickColor(...names: readonly string[]): string | undefined {
  for (const name of names) {
    if (!readCssVar(name)) {
      continue;
    }
    const probe = document.createElement("span");
    probe.style.display = "none";
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    let hex: string | undefined;
    try {
      hex = toHex(getComputedStyle(probe).color);
    } finally {
      probe.remove();
    }
    if (hex) {
      return hex;
    }
  }
  return undefined;
}

/** The `theme` / `themeVariables` pair to initialize mermaid with. */
export function editorTheme(): { theme: "base"; themeVariables: ThemeVariables } {
  const themeVariables: ThemeVariables = { darkMode: isDarkTheme() };
  for (const [key, ...names] of COLORS) {
    const color = pickColor(...names);
    if (color) {
      themeVariables[key] = color;
    }
  }
  CHART_PALETTE.forEach((name, index) => {
    const color = pickColor(name);
    if (color) {
      themeVariables[`pie${index + 1}`] = color;
      themeVariables[`cScale${index}`] = color;
    }
  });
  const fontFamily = readCssVar("--vscode-font-family");
  if (fontFamily) {
    themeVariables.fontFamily = fontFamily;
  }
  const fontSize = readCssVar("--vscode-font-size");
  if (fontSize) {
    themeVariables.fontSize = fontSize;
  }
  return { theme: "base", themeVariables };
}
