/**
 * The TextMate scopes a grammar can produce, and a sheet to recolour them from.
 *
 * VSCode has no contribution point for turning one grammar off, and none for
 * changing what a grammar paints either -- colour comes from the theme, and a
 * theme addresses tokens by scope. So the answer to "let me set the highlight
 * colours" is `editor.tokenColorCustomizations.textMateRules`, which has been
 * there all along and is unusable for one reason: nobody knows the scope names.
 * `Developer: Inspect Editor Tokens and Scopes` tells you the one under the
 * cursor, one token at a time. This produces the whole list for a language at
 * once, which is the part that was missing.
 */

/**
 * Every scope name in a parsed tmLanguage, deduplicated and sorted.
 *
 * A walk rather than a schema, because the shape is recursive in several
 * directions at once: `patterns` nest, `repository` holds named rules that hold
 * more patterns, and the four capture maps are keyed by capture number. Every
 * one of them can carry a `name`.
 *
 * Two things are deliberately left out. The grammar's own top-level `name` is
 * its display name -- "Solidity", not a scope -- so the walk starts below it.
 * And a scope containing `$` is a template filled in from a capture group
 * (`entity.name.tag.$2.html`), which is not a scope anybody can write a theme
 * rule for; the ones it expands to are not knowable without tokenizing a file.
 */
export function scopesIn(grammar: unknown): string[] {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    // TextMate allows several scopes in one `name`, separated by spaces.
    for (const scope of value.split(/\s+/)) {
      if (scope && !scope.includes("$")) {
        found.add(scope);
      }
    }
  };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child);
      }
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "name" || key === "contentName") {
        add(value);
      } else {
        walk(value);
      }
    }
  };
  if (grammar && typeof grammar === "object") {
    const { name: _display, ...rest } = grammar as Record<string, unknown>;
    walk(rest);
    // The root scope is not in any rule but is the one a theme uses to say
    // "everything in this language", so it belongs on the sheet.
    add((grammar as Record<string, unknown>).scopeName);
  }
  return [...found].sort();
}

/** The placeholder every rule carries, so nothing changes until it is edited. */
const PLACEHOLDER = "#RRGGBB";

/**
 * A `textMateRules` array covering `scopes`, as a document to copy out of.
 *
 * A document rather than a write into settings.json. Writing would mean putting
 * several hundred rules into somebody's settings on one keystroke and leaving
 * them to delete the ones they did not want, and a file that big is no longer
 * reviewable -- the point of the sheet is to pick a handful of scopes off it.
 *
 * The placeholder is not a colour. Pasted unedited it is ignored, which is the
 * right way for this to fail: no rule can quietly recolour something because
 * the default got left in.
 */
export function colorSheet(language: string, source: string, scopes: string[]): string {
  const rules = scopes
    .map(
      (scope) =>
        `    { "scope": ${JSON.stringify(scope)}, `
        + `"settings": { "foreground": "${PLACEHOLDER}" } }`,
    )
    .join(",\n");
  return `// Every TextMate scope the \`${language}\` grammar can produce.
// Grammar: ${source}
//
// Copy the rules you want into your settings, replacing ${PLACEHOLDER} with the
// colour you want. Anything left as ${PLACEHOLDER} is not a colour and is
// ignored, so nothing changes until you edit it.
//
// A rule with a longer scope wins over a shorter one, so
// "comment.line.double-slash" beats "comment". Your rules win over the theme's.
//
// poly does not paint anything itself: the grammar names the tokens and the
// theme colours them. There is also no way to switch one grammar off -- VSCode
// registers them statically, so the only off switch is disabling the extension.
{
  "editor.tokenColorCustomizations": {
    "textMateRules": [
${rules}
    ]
  }
}
`;
}
