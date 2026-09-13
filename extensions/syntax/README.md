# Poly Syntax Highlight

統一 syntax highlighting 文法包（批次 1：25 語言）。文法一律從上游 repo／marketplace VSIX
以 pinned 版本同步（`grammars/sources.json` 為單一真相，`tools/grammar-sync.py` 產生本
extension 的 syntaxes 與 contributes），任何 VSCode color theme 直接生效。

## 涵蓋

- **接管內建**（與內建同源、由 poly 控制更新節奏）：swift、c#、lua、go、c、c++/cuda、
  xml/xsl、yaml、markdown（另加清單自動接續，見下）、sql、dockerfile、shellscript；
  rust 採社群強化文法（dustypomerleau/rust-syntax）。
- **新增語言**：HCL、Terraform、nginx、zig、toml、go template（含 go/html/markdown
  injection）、dotenv、protobuf、mermaid（含 markdown code block injection）、svelte、
  graphql（含 js/ts/vue/svelte/python 內 gql template injection）、csv/tsv（rainbow 欄位上色）。

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

## 更新

poly-syntax-highlight 本身零執行期程式碼，更新提示由 poly-lsp 代管（兩者同版號發佈、
一鍵同時更新）。只安裝 poly-syntax-highlight 的使用者請自行從 GitHub Releases 下載新版
VSIX 安裝。

## 授權

各文法保留上游授權，完整清單見隨附的 THIRD-PARTY-NOTICES.md（由同步管線自動產生，含 pin 版本）。
