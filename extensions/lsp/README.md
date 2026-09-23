# Poly LSP

存檔即時 lint／format，背後是 `poly lsp` daemon。編輯器與 CI 跑的是同一個 binary、同一份
設定，所以本機存檔跟 pipeline 的結果一定一致。

## 功能

- **Format**：Format Document／`editor.formatOnSave`，加上批次命令 Format
  File／Folder／Workspace／Git Repo／Git Changed Files。**Format Selection** 只交回落在選取
  範圍內的變更。專案有 `.editorconfig` 就直接沿用縮排、行寬、行尾空白與檔尾換行，包括
  poly 不格式化的檔案（`.ini`、Makefile……）。
- **Lint**：存檔即時 diagnostics 進 Problems panel；`Poly: Lint (poly check)` 在終端跑完整
  CLI。內嵌 ruff、selene、sqruff，其餘（shellcheck、actionlint、hadolint……）受管下載並以
  sha256 驗證；專案自己的 biome／eslint 優先。
  - **三個工具讀不了單一 buffer**，所以跑的是整個範圍：golangci-lint 一個 Go module、
    cargo clippy 一個 workspace、tflint 一個目錄。它們比單檔 linter 慢，答案是存檔後幾秒才到。
- **`Poly: Analyze Dead Code`**：Go／TypeScript／JavaScript／Python 的整體可達性分析，
  工具各自來自該語言的 toolchain（deadcode／knip／vulture），poly 不代裝。範圍是專案不是檔案。
- **`Poly: Minify`**：把當前 buffer 壓成一行，涵蓋 JSON／JSONC、CSS、HTML、XML、
  JavaScript／TypeScript。只移除空白與註解，不改名、不折常數、不刪分支。唯一例外是 CSS：
  壓縮印表機同時會把值寫成最短等價形式（`blue` → `#00f`）。YAML／TOML 不處理（換行有意義）。
  刻意不進 format-on-save——它是格式化的反向。
- **狀態列的 Format／Lint 兩個總開關**：關掉的不只 poly，是整個編輯器。
  - **Format**（`Poly: Toggle Formatting`）：存檔／打字／貼上時格式化、存檔時的 code action
    （organizeImports 之類）、行尾空白與結尾換行、poly 自己的所有改寫，**包括其他 extension
    自帶的各語言預設**——golang.go 的 `[go]` 存檔格式化、Pylance 的 `[python]` 打字格式化，
    只改全域設定的開關擋不到這些。
  - **Lint**（`Poly: Toggle Linting`）：poly 的 lint，加上已安裝的 ruff、Go 存檔時的
    lint／vet、rust-analyzer 存檔時的 check、Code Spell Checker、autocorrect、ESLint、
    ShellCheck、Stylelint、Pylint、Flake8。編譯與型別錯誤不是 lint，照常顯示。
  - 再按一次，每一項**還原成原本的樣子**；關著的時候你自己改過的設定不會被蓋掉。只寫使用者
    設定，不動專案的 `.vscode/settings.json`——那裡若還開著什麼，開關的提示會列出來。
  - 手動用其他 extension 的 formatter 跑 Format Document 照樣有效（那是你要求的）。
    markdownlint 與 gremlins 沒有關閉的設定，關不到。
- **規則說明**：SQL 的波浪線上 hover 會顯示 sqruff 該條規則的全文（編在 binary 裡，離線可讀）；
  其他工具走規則代碼上的超連結。
- **Protobuf**（`.proto`）由 buf 處理，格式化免設定。**lint 只在有 `buf.yaml` 的 module 裡跑**，
  否則會大聲跳過。
- **Jupyter notebook**（`.ipynb`）由內嵌的 ruff 整份處理，outputs 與 markdown cell 原樣保留。
  VSCode 的 notebook editor 不走 LSP 文字文件，所以要用批次命令或 `poly fmt`。
- 背景檢查 GitHub Releases，一鍵更新已安裝的那幾個 extension。

## 語言功能（預設關閉）

`poly.languageServers` 打開後，poly 把 hover、definition、references、outline、completion、
rename、code action、inlay hint、call/type hierarchy、semantic tokens 等路由給**專案自己
toolchain 裡的** language server：gopls、rust-analyzer、clangd、sourcekit-lsp、terraform-ls、
lua-language-server、bash-language-server，以及 poly 代抓的 buf 與 arity。

poly 不實作任何一行語意分析，只做路由，所以品質就是那支 server 的品質。server 一律從 PATH
找，找不到就說一聲。改完要重新載入視窗。

**已經有官方 extension 的語言，poly 讓開**：裝了 Go（golang.go）、rust-analyzer、clangd 或
C/C++、Swift、HashiCorp Terraform、Lua（sumneko）、Bash IDE、Buf 的那幾個語言，poly 不啟動
自己那支 server，同一個語言不會有兩支在跑、兩份 hover。裝上或移除那個 extension 時 poly
自己重新分配，不用重新載入視窗。

存檔時會跑的 `source.*` code action 不轉（會跟 poly 的格式化搶同一段程式碼），燈泡裡的照常。

## 快捷鍵

| 命令           | mac         | Windows／Linux |
| -------------- | ----------- | -------------- |
| `Poly: Minify` | `cmd+alt+m` | `ctrl+alt+m`   |

其餘命令沒有預設快捷鍵，從命令面板叫，或自己在 `keybindings.json` 綁：
`poly.formatFile`／`formatPath`／`formatWorkspace`／`formatGitRepo`／`formatGitChanged`、
`poly.lintPath`、`poly.analyzeDeadCode`、`poly.toggleFormat`、`poly.toggleLint`、`poly.createGoWork`、
`poly.checkForUpdates`、`poly.showOutput`。

## 設定

| 設定                            | 預設    | 作用                                                         |
| ------------------------------- | ------- | ------------------------------------------------------------ |
| `poly.serverPath`               | `""`    | 改用指定路徑的 poly binary，空字串是用內附的那支             |
| `poly.lintOnSave`               | `true`  | 開檔與存檔時跑 lint，改了立即生效；Lint 開關也寫這一項       |
| `poly.format.enabled`           | `true`  | 關掉後 poly 的所有改寫都不動作；Format 開關也寫這一項        |
| `poly.deadCodeCodeLens.enabled` | `false` | 每個 Go／TS／JS／Python 檔第一行上方一條 `analyze dead code` |
| `poly.languageServers`          | `false` | 把語言功能路由給下游 server（見上），改完要重新載入視窗      |
| `poly.languageServerLogs`       | `true`  | 下游 server 的 stderr 轉進 Poly 輸出面板                     |
| `poly.memoryLog`                | `false` | 每開關一個檔寫一行 daemon 握著什麼（RSS、文件數、各快取）    |
| `poly.updateCheck.enabled`      | `true`  | 背景檢查新版                                                 |
| `poly.updateCheck.intervalDays` | `7`     | 檢查間隔，`0` 是每次啟動都查                                 |

每一項的完整說明在 VSCode 的設定頁（英文與正體中文都有）。專案層的格式化與工具設定寫在
`poly.toml`，不在這裡——見專案根目錄的 README。

## 設計理由

搬到 `dev_docs/vscode-syntax`。這裡只寫結論。
