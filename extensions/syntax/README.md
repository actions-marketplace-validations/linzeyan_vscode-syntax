# Poly Syntax Highlight

153 份文法，一個 extension。文法一律從上游 repo／marketplace VSIX 以 pinned commit 同步
（`grammars/sources.json` 是單一真相，`tools/grammar-sync.py` 產生本 extension 的 syntaxes
與 contributes），輸出標準 TextMate scope，任何 VSCode color theme 直接生效。

## 涵蓋

- **接管 49 個內建語言**：多數與內建同源，只是更新節奏由 poly 控制；rust 改用社群的
  dustypomerleau/rust-syntax，scope 比內建細。
- **另加 47 個內建沒有的語言**：HCL／Terraform、nginx、zig、toml、go template、dotenv、
  protobuf、mermaid、svelte、graphql、jsonnet、just、nix、cabal、dune、ocaml、elixir、
  erlang、haskell、scala、caddyfile、systemd unit、apacheconf、ssh_config、jinja 家族、
  Solidity／Cairo／Vyper，以及 csv／tsv 的 rainbow 欄位上色。
- 完整清單在 `package.json` 的 `contributes.languages`，授權與 pin 在
  THIRD-PARTY-NOTICES.md。

## markdown 清單自動接續

在清單項目上按 Enter 會接出同一層的下一項：`-`／`*`／`+`、`1.`／`1)`、`- [ ]` 任務項、
`>` 引言，縮排照舊。**VSCode 內建完全沒有這個行為**（實測 1.120，不裝任何 extension 時
`- foo` 按 Enter 只得到空行）。

有序清單接出來的一律是 `1.`，不是遞增的下一個號碼——語言設定檔只能接一段固定文字，數不了
數。`1.` 重複是 CommonMark 認可的寫法，`poly fmt` 原樣保留，rumdl 也不抱怨。**同時裝了
poly-editor 的話，Enter 由它接管**，號碼會遞增，空的項目按 Enter 也會結束清單；這裡這份是
單獨安裝 poly-syntax-highlight 時的宣告式版本。

**同一份規則也套用在 markdown 家族的其他 language id 上**：VSCode 1.120 的
`prompt-basics` 把 `SKILL.md`、`*.prompt.md`、`*.instructions.md`、`*.chatmode.md`、
`.claude/agents/**`、`.claude/rules/**`、`.github/agents/**`、`copilot-instructions.md`
從 `markdown` 分出去成 `skill`／`prompt`／`instructions`／`chatagent`，而它自己沒帶任何
清單行為。只認 `markdown` 的話，最常被當 markdown 編輯的那批檔案反而一個接續都沒有。

## 驗證覆蓋是否生效

開啟 `.rs` 檔 → `Developer: Inspect Editor Tokens and Scopes` → 游標放在 `->` 上，
scopes 應含 `keyword.operator.arrow.skinny.rust`（內建文法無此 scope）。

## 配色與開關

**poly 不帶配色。** 文法只負責替 token 取名（scope），顏色是主題給的——所以換主題就是
換配色，poly 不參與。

要自己改某個 scope 的顏色，用 VSCode 本來就有的
`editor.tokenColorCustomizations.textMateRules`。它一直都能用，卡住的只有一件事：沒人
知道 scope 叫什麼名字。裝了 **poly-editor** 的話，`Poly: Syntax Colors for This Language`
會把目前這個語言的文法能產生的**全部** scope 列成一份可以直接複製的設定片段；沒裝的話，
內建的 `Developer: Inspect Editor Tokens and Scopes` 一次告訴你游標下的那一個。

**沒有「只關掉某個文法」這種開關，而且那不是 poly 偷懶。** VSCode 的文法是靜態註冊的，
沒有任何 contribution point 能在執行期停用其中一份。唯一的關法是停用整個 extension。
poly 不做一個按了沒作用的假開關。

## 更新

poly-syntax-highlight 本身零執行期程式碼，更新提示由 poly-lsp 代管（兩者同版號發佈、
一鍵同時更新）。只安裝 poly-syntax-highlight 的使用者請自行從 GitHub Releases 下載新版
VSIX 安裝。

## 授權

各文法保留上游授權，完整清單見隨附的 THIRD-PARTY-NOTICES.md（由同步管線自動產生，含 pin 版本）。
