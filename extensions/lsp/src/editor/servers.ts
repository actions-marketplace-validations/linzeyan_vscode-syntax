/**
 * Why a feature that is switched on is drawing nothing.
 *
 * poly's lenses count answers somebody else produced. Turn the reference lens
 * on in a .sh, or the protobuf lens on in a .proto, and with no language server
 * for that language there is nothing to count -- so the lens correctly draws
 * nothing, and the user is looking at a setting they just enabled doing
 * visibly nothing. Both features were reported as broken for exactly this
 * reason; neither was.
 *
 * poly can run a server for ten languages, behind `poly.languageServers`. This
 * file decides when it is worth saying so, and the rule is deliberately narrow:
 * only after a provider has actually been asked and come back empty. Offering
 * on the strength of the language id alone would pester everyone who already
 * has the official extension installed and working.
 */

/**
 * The server poly would run for a language, by its editor language id.
 *
 * The ten from `poly.languageServers`. C and C++ share clangd, which is why it
 * appears twice rather than the map being keyed by server.
 */
export const SERVERS: ReadonlyMap<string, string> = new Map([
  ["go", "gopls"],
  ["rust", "rust-analyzer"],
  ["c", "clangd"],
  ["cpp", "clangd"],
  ["swift", "sourcekit-lsp"],
  ["terraform", "terraform-ls"],
  ["lua", "lua-language-server"],
  ["shellscript", "bash-language-server"],
  ["protobuf", "buf"],
  ["r", "arity"],
]);

/**
 * The server to offer for `languageId`, or nothing at all.
 *
 * `asked` is per language and not per file: the answer is a property of the
 * language, so a workspace of forty .proto files is one question. Nothing is
 * offered twice in a session even if declined, because the decline is the
 * answer and the setting is in the same panel as the feature they just turned
 * on.
 */
export function serverToOffer(
  languageId: string,
  asked: ReadonlySet<string>,
): string | undefined {
  return asked.has(languageId) ? undefined : SERVERS.get(languageId);
}

/**
 * What to say, given the feature that came up empty.
 *
 * Names the observation rather than the feature: "nothing answers X" is
 * checkable by the reader, where "the lens is broken" is a claim about code
 * they cannot see. The action is spelled out because `poly.languageServers`
 * needs a reload, and a setting that appears to do nothing until the next
 * window is how this feature got its reputation in the first place.
 */
export function offerMessage(what: string, languageId: string, server: string): string {
  return `Poly: nothing answers ${what} for ${languageId}. `
    + `Poly can run ${server} for it — enable poly.languageServers and reload?`;
}
