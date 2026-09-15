// The scenarios poly-editor and the extension it replaced are both asked to
// answer. One case = one document, one cursor, one command on each side.
//
// `expect` records what the difference is *for*, and is the whole point of the
// table: poly-editor did not set out to clone markdown-all-in-one, it set out
// to replace it, and three of these behaviours are deliberate improvements
// (08 §9). A case with `expect: "same"` that differs is a defect; a case with a
// stated reason that stops differing means poly lost the improvement.
//
//   same      -- the two must produce identical text and selection
//   <reason>  -- they must differ, and this is why
//
// What is not here, and cannot be: poly-editor's indent tint, gutter image
// previews and TODO panel. Those three only ever appear as decorations and a
// TreeView, and no API reads back what another extension drew. The obvious way
// round it was measured and does not work -- the `TextEditor` this suite holds
// really is the same object every extension is handed (`activeTextEditor ===
// editor` is true), but VSCode freezes it, so assigning over `setDecorations`
// fails silently and intercepts nothing, poly's own calls included. Screenshots
// are what is left, and the two palettes differ by design, so only something
// structural ("which columns are tinted") would mean anything. 08 §3.

/** `|` marks the cursor, `«`...`»` a selection; both are stripped before opening. */
const CASES = [
  // ── Enter: list continuation ─────────────────────────────────────────────
  {
    id: "enter/bullet",
    language: "markdown",
    text: "- alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/bullet-star",
    language: "markdown",
    text: "* alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/ordered-increments",
    language: "markdown",
    text: "1. alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/ordered-all-ones",
    language: "markdown",
    // Every sibling written as `1.`, which poly reads as the document's style
    // and keeps; markdown-all-in-one has a setting for this instead.
    text: "1. alpha\n1. beta|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "poly infers the marker style from the previous sibling (08 §9)",
  },
  {
    id: "enter/task",
    language: "markdown",
    text: "- [x] alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/quote",
    language: "markdown",
    text: "> alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/empty-item-ends-list",
    language: "markdown",
    text: "- alpha\n- |\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/empty-nested-item-outdents",
    language: "markdown",
    text: "- alpha\n  - |\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/not-a-list",
    language: "markdown",
    text: "plain paragraph|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },

  // ── the markdown family VSCode 1.120 split out of `markdown` ─────────────
  // poly claims these five ids; markdown-all-in-one knows only `markdown`, so
  // every one of them is a case where poly is supposed to be the better half.
  {
    id: "enter/prompt-id",
    language: "prompt",
    text: "- alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "markdown-all-in-one does not claim the prompt language id (08 §8)",
  },
  {
    id: "enter/skill-id",
    language: "skill",
    text: "- alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "markdown-all-in-one does not claim the skill language id (08 §8)",
  },

  // ── Tab / Shift+Tab: list indentation ────────────────────────────────────
  {
    id: "tab/nest-under-bullet",
    language: "markdown",
    text: "- alpha\n- |beta\n",
    original: "markdown.extension.onTabKey",
    poly: "poly.indentListItem",
    expect: "same",
  },
  {
    id: "tab/nest-under-ordered",
    language: "markdown",
    // `1. ` is three columns wide, and that is the indent dprint normalizes to.
    text: "1. alpha\n1. |beta\n",
    original: "markdown.extension.onTabKey",
    poly: "poly.indentListItem",
    expect: "same",
  },
  {
    id: "shift-tab/outdent",
    language: "markdown",
    text: "- alpha\n  - |beta\n",
    original: "markdown.extension.onShiftTabKey",
    poly: "poly.outdentListItem",
    expect: "same",
  },
  {
    id: "shift-tab/orphan-at-left-edge",
    language: "markdown",
    text: "    - |orphan\n",
    original: "markdown.extension.onShiftTabKey",
    poly: "poly.outdentListItem",
    expect: "same",
  },

  // ── emphasis ─────────────────────────────────────────────────────────────
  {
    id: "bold/word-under-cursor",
    language: "markdown",
    text: "make al|pha bold\n",
    original: "markdown.extension.editing.toggleBold",
    poly: "poly.toggleBold",
    expect: "same",
  },
  {
    id: "bold/undo-existing",
    language: "markdown",
    text: "make **al|pha** plain\n",
    original: "markdown.extension.editing.toggleBold",
    poly: "poly.toggleBold",
    expect: "same",
  },
  {
    id: "italic/word-under-cursor",
    language: "markdown",
    // poly emits `_a_`, which is what dprint-plugin-markdown normalizes to;
    // markdown-all-in-one emits `*a*` unless configured otherwise (08 §9).
    text: "make al|pha italic\n",
    original: "markdown.extension.editing.toggleItalic",
    poly: "poly.toggleItalic",
    expect: "poly emits the marker `poly fmt` would keep (08 §9)",
  },

  // ── table of contents ────────────────────────────────────────────────────
  {
    id: "toc/create",
    language: "markdown",
    text: "|\n\n# Title\n\n## Section One\n\n### Nested\n\n## Section Two\n",
    original: "markdown.extension.toc.create",
    poly: "poly.insertTableOfContents",
    expect:
      "poly frames the block in comment markers so it can update in place, and leaves H1 out as the document's own title",
  },

  // ── Enter: the edges of "continue the list" ──────────────────────────────
  // Everything above is a list item the cursor sits at the end of. These are
  // the shapes where the two implementations have to decide something: where
  // the split lands, which marker counts as a marker, and when a list is not a
  // list at all. Note what is *not* here -- both Enter bindings carry
  // `!editorHasSelection && !editorHasMultipleSelections`, so a case with a
  // selection would compare a path no keypress can reach.
  {
    id: "enter/split-mid-item",
    language: "markdown",
    // The tail has to move to the new item, and the new marker has to precede
    // it. Appending at the end of the line never shows which one happens.
    text: "- al|pha\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/ordered-paren-delimiter",
    language: "markdown",
    text: "1) alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/plus-marker",
    language: "markdown",
    text: "+ alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/task-unchecked",
    language: "markdown",
    // The new item must come out unchecked whichever box the old one had.
    text: "- [ ] alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/renumbers-the-tail",
    language: "markdown",
    // Inserting in the middle of an ordered list leaves every later item
    // wrong. markdown-all-in-one renumbers by default (orderedList.autoRenumber
    // = true), so a poly that only writes the marker would differ here.
    text: "1. alpha\n2. beta|\n3. gamma\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/nested-quote",
    language: "markdown",
    text: "> > alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/inside-fenced-code",
    language: "markdown",
    // A dash inside a code fence is a dash, not a bullet. Neither keybinding
    // has a context key for this, so whether it is handled at all is the
    // extension's own business -- and the two must still agree.
    text: "```\n- alpha|\n```\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/trailing-spaces",
    language: "markdown",
    text: "- alpha   |\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "same",
  },
  {
    id: "enter/yaml-list",
    language: "yaml",
    // poly binds Enter in yaml as well, where `- ` is a sequence entry and
    // continuing it is the same courtesy. markdown-all-in-one never sees yaml.
    text: "items:\n  - alpha|\n",
    original: "markdown.extension.onEnterKey",
    poly: "poly.continueList",
    expect: "poly continues yaml sequences too; markdown-all-in-one binds only markdown",
  },

  // ── Tab / Shift+Tab: the edges of "indent the item" ──────────────────────
  {
    id: "tab/first-item-has-nothing-to-nest-under",
    language: "markdown",
    // A list's first item has no sibling above it, so there is no level to
    // become a child of. markdown-all-in-one indents it anyway, to four
    // spaces, and four spaces at the top of a document is an indented code
    // block -- the item stops being a list item at all. poly leaves Tab to do
    // what Tab does, which is what its `when` clause promises: every case the
    // command does not handle behaves as if nothing were bound to the key.
    text: "- |alpha\n- beta\n",
    original: "markdown.extension.onTabKey",
    poly: "poly.indentListItem",
    expect: "poly declines to indent a first item; the original makes it an indented code block",
  },
  {
    id: "tab/not-a-list-at-all",
    language: "markdown",
    text: "plain |paragraph\n",
    original: "markdown.extension.onTabKey",
    poly: "poly.indentListItem",
    expect: "same",
  },
  {
    id: "shift-tab/not-a-list-at-all",
    language: "markdown",
    text: "plain |paragraph\n",
    original: "markdown.extension.onShiftTabKey",
    poly: "poly.outdentListItem",
    expect: "same",
  },
  {
    id: "tab/inside-fenced-code",
    language: "markdown",
    text: "```\n- alpha\n- |beta\n```\n",
    original: "markdown.extension.onTabKey",
    poly: "poly.indentListItem",
    expect: "same",
  },

  // ── emphasis: the edges of "what does this toggle wrap" ──────────────────
  {
    id: "bold/selection-spanning-words",
    language: "markdown",
    text: "«make alpha» bold\n",
    original: "markdown.extension.editing.toggleBold",
    poly: "poly.toggleBold",
    expect: "same",
  },
  {
    id: "bold/empty-line",
    language: "markdown",
    // Nothing to wrap: both are expected to open the markers and leave the
    // cursor between them, ready to type.
    text: "|\n",
    original: "markdown.extension.editing.toggleBold",
    poly: "poly.toggleBold",
    expect: "same",
  },
  {
    id: "bold/cursor-after-word",
    language: "markdown",
    // The cursor is past the last letter rather than inside the word, which is
    // where "the word under the cursor" stops being obvious.
    text: "alpha| beta\n",
    original: "markdown.extension.editing.toggleBold",
    poly: "poly.toggleBold",
    expect: "same",
  },
  {
    id: "bold/selection-inside-existing-bold",
    language: "markdown",
    // Selecting the text inside `**...**` and pressing Ctrl+B means "stop
    // being bold". poly reads the markers either side of the selection and
    // removes them; markdown-all-in-one only looks at the selected text, sees
    // no markers in it, and wraps again -- leaving `****make alpha****`.
    // The same document with a bare cursor instead of a selection is
    // `bold/undo-existing` above, where the two do agree.
    text: "**«make alpha»** plain\n",
    original: "markdown.extension.editing.toggleBold",
    poly: "poly.toggleBold",
    expect: "poly unwraps markers that surround the selection; the original wraps a second pair",
  },
  {
    id: "italic/undo-existing-underscore",
    language: "markdown",
    // poly writes `_a_`, so it has to recognise `_a_` when undoing;
    // markdown-all-in-one is looking for its own `*a*` and wraps instead.
    text: "make _al|pha_ plain\n",
    original: "markdown.extension.editing.toggleItalic",
    poly: "poly.toggleItalic",
    expect: "poly removes the marker it writes; markdown-all-in-one only undoes its own `*` (08 §9)",
  },

  // ── clipboard ────────────────────────────────────────────────────────────
  {
    id: "copy-path/single-line",
    language: "markdown",
    text: "alpha\nbe|ta\ngamma\n",
    original: "copy-relative-path-and-line-numbers.both",
    originalFrom: "ezforo.copy-relative-path-and-line-numbers",
    poly: "poly.copyPathWithLine",
    reads: "clipboard",
    expect: "same",
  },
  {
    id: "copy-path/range",
    language: "markdown",
    text: "alpha\n«beta\ngamma»\n",
    original: "copy-relative-path-and-line-numbers.both",
    originalFrom: "ezforo.copy-relative-path-and-line-numbers",
    poly: "poly.copyPathWithLine",
    reads: "clipboard",
    expect: "poly writes `:2-3`, the shape rg prints; the original separates with `~`",
  },
  {
    id: "copy-path/selection-ends-at-column-0",
    language: "markdown",
    // Selecting a whole line by dragging to the start of the next one is the
    // ordinary gesture, and it leaves the end of the selection at column 0 of
    // a line that has nothing selected in it. poly reports the one line the
    // user actually took (`:2`); the original counts the line it stopped on
    // and reports `2~3`, naming a line that is not in the selection.
    text: "alpha\n«beta\n»gamma\n",
    original: "copy-relative-path-and-line-numbers.both",
    originalFrom: "ezforo.copy-relative-path-and-line-numbers",
    poly: "poly.copyPathWithLine",
    reads: "clipboard",
    expect:
      "a selection ending at column 0 does not reach that line, so poly writes `:2` where the original writes `2~3`",
  },

  // ── table of contents ────────────────────────────────────────────────────
  {
    id: "toc/duplicate-and-non-ascii-headings",
    language: "markdown",
    // Two headings with the same text need distinct anchors, and a heading
    // with no ASCII in it needs one at all. The block differs either way, so
    // what this case is for is the record it leaves in editor-diff.json.
    text: "|\n\n# Title\n\n## Setup\n\n## Setup\n\n## 設定與說明\n",
    original: "markdown.extension.toc.create",
    poly: "poly.insertTableOfContents",
    expect:
      "poly frames the block and leaves H1 out; the anchors themselves agree -- measured `#setup`, `#setup-1`, `#設定與說明` on both sides",
  },
];

module.exports = { CASES };
