/**
 * Picking one refactoring out of everything a language server offers.
 *
 * `editor.action.refactor` already exists and already works. What it does not
 * do is go straight to the one you meant: it opens a menu, the menu's contents
 * differ per language, and the entry you want is worded differently in every
 * server ("Extract into variable", "Extract to constant in enclosing scope",
 * "Extract subexpression to variable"). A keybinding cannot land on any of
 * those, so the gesture is always at least three keystrokes and a read.
 *
 * poly computes no refactoring here. It asks the editor for code actions of a
 * standard kind, decides which of the answers is the one the command's name
 * promised, and applies it. The deciding is this file, and it is the only part
 * worth testing.
 */

/** Which command is asking. */
export type Refactoring =
  | "extractVariable"
  | "inlineVariable"
  | "moveToNewFile"
  | "changeSignature"
  | "implementInterface";

/** What one command asks for, and how it recognises the answer. */
export interface Wanted {
  /**
   * The `CodeActionKind` to ask the providers for.
   *
   * These are the kinds the LSP specification names, so every server that
   * implements the refactoring at all tags it with one of them -- which is why
   * this works without knowing anything about the language.
   */
  readonly kind: string;
  /** Titles and sub-kinds that mean this command's name. */
  readonly means: RegExp;
  /**
   * Whether an unrecognised answer of the right kind is offered anyway.
   *
   * True only where the kind is already the refactoring: `refactor.inline` is
   * one thing, so a server whose wording this file has never seen should cost
   * the user a menu rather than the feature. False where the kind is a shared
   * bucket -- `quickfix` holds every fix in the file, and a command called
   * Implement Interface that offers "remove unused import" is worse than one
   * that says it found nothing.
   */
  readonly fallback: boolean;
  /** What the command is called, in a message to the user. */
  readonly title: string;
  /** What to try when nothing came back, in the same message. */
  readonly hint: string;
}

/**
 * Words that mean "and the thing it extracts to, or inlines, is a variable".
 *
 * Measured across the servers poly proxies plus the built-in TypeScript one:
 * gopls says "Extract variable", rust-analyzer "Extract into variable" and
 * "Inline variable", clangd "Extract subexpression to variable", TypeScript
 * "Extract to constant in enclosing scope". A constant counts -- TypeScript
 * has no other word for a local binding, and someone who asked for a variable
 * and got `const x = ...` got what they asked for.
 */
const VARIABLE = /\b(variable|constant|const|local)\b|\.(variable|constant)\b/i;

export const REFACTORINGS: Readonly<Record<Refactoring, Wanted>> = {
  extractVariable: {
    kind: "refactor.extract",
    means: VARIABLE,
    fallback: true,
    title: "Extract Variable",
    hint: "select an expression",
  },
  inlineVariable: {
    kind: "refactor.inline",
    means: VARIABLE,
    fallback: true,
    title: "Inline Variable",
    hint: "put the cursor on the binding",
  },
  moveToNewFile: {
    // Not `refactor.move`: the standard kind exists and gopls 0.23 answers null
    // for it (measured 2026-09-21). What it does offer is
    // `refactor.extract.toNewFile`, "Extract declarations to new file", which
    // is the same gesture filed under the other kind.
    kind: "refactor.extract",
    means: /\bnew file\b|toNewFile/i,
    fallback: false,
    title: "Move to New File",
    hint: "put the cursor on a declaration's name",
  },
  changeSignature: {
    // There is no "Change signature…" dialog to route to. gopls spells a
    // signature change as several small rewrites -- "Move parameter left",
    // "Split parameters into separate lines", and "Remove unused parameter"
    // when one is unused -- and each is a code action of this kind. Offering
    // the list is the honest version of the one dialog other tools show.
    kind: "refactor.rewrite",
    means: /\bparam(eter)?s?\b|\bsignature\b/i,
    fallback: false,
    title: "Change Signature",
    // Measured: gopls answers null for `refactor.rewrite` at a function's name
    // and answers with the parameter rewrites at a parameter. The position is
    // the whole difference, so the message has to say which one.
    hint: "put the cursor on a parameter",
  },
  implementInterface: {
    // A quickfix and not a refactoring, because that is where every server
    // files it: the missing methods are a type error, and stubbing them is the
    // fix for it. gopls says "Declare missing methods of Shape", rust-analyzer
    // "Implement missing members", TypeScript "Implement interface 'Shape'".
    kind: "quickfix",
    means: /\bmissing (method|member)|\bunimplemented\b|\bimplement\b.*\binterface\b/i,
    fallback: false,
    title: "Implement Interface",
    // The server offers this against a diagnostic, so there has to be one:
    // in Go that means the assignment that fails to compile, `var _ Shape =
    // Triangle{}`, already being in the file. poly cannot conjure the
    // diagnostic without deciding which interface was meant, which is the
    // analysis it does not do.
    hint: "put the cursor where the compiler says a method is missing",
  },
};

/** As much of `vscode.CodeAction` as the choice below depends on. */
export interface Offered {
  readonly title: string;
  /** `vscode.CodeActionKind.value`; absent is legal and means "unclassified". */
  readonly kind?: string;
}

/**
 * The actions a command should offer, best first.
 *
 * Two filters, and the second one is the point. The kind filter is what the
 * editor was already asked for, repeated here because a provider may answer
 * with more than it was asked for. The meaning filter is what makes the
 * command's name true: `refactor.extract` also covers "Extract function" and
 * "Extract method", and a command called Extract Variable that silently
 * extracts a function is worse than one that does nothing.
 */
export function refactorChoices<T extends Offered>(
  offered: readonly T[],
  want: Refactoring,
): T[] {
  const wanted = REFACTORINGS[want];
  const ofKind = offered.filter(
    // Prefix, not equality: `refactor.extract.constant` is a `refactor.extract`
    // and the dot is what keeps `refactor.extractive` from being one.
    (one) => one.kind === wanted.kind || (one.kind?.startsWith(`${wanted.kind}.`) ?? false),
  );
  const meant = ofKind.filter(
    (one) => wanted.means.test(one.title) || (one.kind !== undefined && wanted.means.test(one.kind)),
  );
  return meant.length > 0 || !wanted.fallback ? meant : ofKind;
}
