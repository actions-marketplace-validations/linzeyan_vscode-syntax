# Poly Syntax Highlight

153 份 syntax highlighting 文法，一個 extension。輸出標準 TextMate scope，任何 VSCode
color theme 直接生效；**零執行期程式碼**，不佔 extension host 資源。

## 涵蓋

- **接管 49 個 VSCode 內建語言**：多數與內建同源，更新節奏由 poly 控制；rust 改用
  dustypomerleau/rust-syntax，scope 比內建細。
- **另加 47 個內建沒有的語言**：HCL／Terraform、nginx、zig、toml、go template、dotenv、
  protobuf、mermaid、svelte、graphql、jsonnet、just、nix、cabal、dune、ocaml、elixir、
  erlang、haskell、scala、caddyfile、systemd unit、apacheconf、ssh_config、jinja 家族、
  Solidity／Cairo／Vyper，以及 csv／tsv 的 rainbow 欄位上色。

完整清單在 `package.json` 的 `contributes.languages`；授權與各文法釘住的 commit 在
THIRD-PARTY-NOTICES.md。文法一律從上游 repo／marketplace VSIX 以 pinned commit 同步，不手改。

## markdown 清單自動接續

在清單項目上按 Enter 接出同一層的下一項（`-`／`*`／`+`、`1.`／`1)`、`- [ ]`、`>`），內建
沒有這個行為。同一份規則也套用在 `SKILL.md`、`*.prompt.md`、`*.instructions.md`、
`.claude/agents/**` 這些 VSCode 1.120 起不再算 `markdown` 的檔案上。

號碼不會遞增，空項目按 Enter 也不會結束清單——語言設定檔只能接一段固定文字。**裝了
poly-editor 的話 Enter 由它接管**，兩者都有。

## 配色與開關

poly 不帶配色：文法只替 token 取名（scope），顏色是主題給的。

要改某個 scope 的顏色，用 VSCode 本來就有的 `editor.tokenColorCustomizations.textMateRules`。
scope 名稱哪裡查：裝了 poly-editor 就用 `Poly: Syntax Colors for This Language`（一次列出
這個語言的全部 scope），沒裝就用內建的 `Developer: Inspect Editor Tokens and Scopes`
（一次一個，游標下的那個）。

**沒有「只關掉某一份文法」的開關**：VSCode 的文法是靜態註冊的，沒有任何 contribution point
能在執行期停用其中一份。唯一的關法是停用整個 extension；poly 不做按了沒作用的假開關。

## 設定與更新

這個 extension 沒有設定項。更新提示由 poly-lsp 代管（兩者同版號發佈、一鍵同時更新）；
只裝這一個的話，請自行從 GitHub Releases 下載新版 VSIX。

## 授權

各文法保留上游授權，完整清單見 THIRD-PARTY-NOTICES.md（由同步管線產生，含 pin 版本）。
