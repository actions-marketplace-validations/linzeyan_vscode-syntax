# Poly Editor

編輯器端的便利功能，**沒有 CI 對應物**的那些。不需要 poly binary，也不需要 poly-lsp。

**附加功能預設全關**，一項一項在設定裡打開——這個 extension 裝了不會讓你的編輯器多出任何
你沒要的東西。下表標「設定」的那幾項是關的。

## 功能

### markdown

- **Enter 接續清單**：接出同一層的下一項，**有序清單號碼遞增**，任務項接出 `- [ ]`，
  **空的項目按 Enter 結束清單**（往外退一層）。markdown 家族與 yaml 都有。
- **Tab／Shift+Tab 調整清單層級**：游標在內容起點或更左邊時生效，一層是 `poly fmt` 正規化
  出來的那一欄（`- x` 是 2、`1. x` 是 3），不是 `editor.tabSize`。其餘情況原樣還給編輯器，
  包含 Copilot 的 inline suggestion。
- **`Toggle Bold`／`Toggle Italic`**：產生 `**bold**` 與 `_italic_`，也就是 `poly fmt`
  正規化出來的那兩種，不會被下一次存檔改掉。
- **`Insert Table of Contents`**：在游標處插入目錄，用註釋標記框住，再跑一次就地更新。
  錨點照 VSCode 自己的 slug 規則產生。
- **markdown preview 的 mermaid 圖表**（設定）：VSCode 1.135 起內建就有，屆時 poly 自動讓開。

### 導航與 CodeLens

- **`Copy Path with Line Numbers`**：複製 `路徑:行號`，多行選取是 `路徑:42-51`。就是 `rg`
  印的、CI annotation 連過去的、終端機點得動的那個形狀。
- **引用與實作 CodeLens**（設定）：每個宣告一行 `11 refs`；interface 多一顆 `3 impls`，
  具體型別多一顆 `1 interface`，方法寫在型別外面的語言（Go）再多一顆 `4 methods`。
  數字全部來自該語言已註冊的 provider，poly 只數與畫。
  - `N refs`、`N impls`、`N methods` 點下去都一樣：只有一筆就直接跳過去，多筆開檔案總管裡的
    **References** 面板。那是 poly 自己的樹，
    每一列除了原始碼還帶**行號**與**它落在哪個符號裡**（`method Handle`、`func main`）——
    內建的 `references-view` 兩欄都沒有，而別人的樹加不了欄位。
- **`run | debug` CodeLens**（設定）：程式進入點上方一行。`run` 存檔後在一個叫 `Poly Run`
  的終端機裡下命令（go → `go run .`、rust → `cargo run`、python → `python3 檔名`、
  shell → shebang 指定的直譯器），不經過 debugger；要先編譯的 C／C++／Java／C# 只畫
  `debug`。poly 沒有 debugger，`debug` 交給你已經裝的 debug extension。
- **protobuf → 生成的 Go**（設定）：`.proto` 的 `message`／`enum` 上方 `go type`，
  `service` 上方 `go server`／`go client`，`rpc` 上方 `N impls`。點下去跟引用 lens 一樣：
  一筆直接跳、多筆開 **References** 面板，編輯器停在 `.proto` 上。認 protoc-gen-go 與
  protoc-gen-go-grpc 的命名規則；生成檔不在 workspace 裡就不畫。
- **跨檔案 next／previous change**：跳到上／下一個有改動的檔案並落在改動上。內建的只到
  「同一個檔案裡的下一處」。`Revert Selected Changes and Save` 還原游標所在的 hunk 並存檔。

### 編輯

- **Postfix completion**（設定）：`err.if` 展開成 `if err != nil { }`（Go）、`if (err) { }`
  （TS）、`if err:`（Python）。go／rust／swift／ts／js／python／lua／c／cpp 都有。這是文字
  重排不是分析，排在 language server 的答案後面。
- **`Extract Variable`／`Inline Variable`**：每個語言都通用——問的是 LSP 標準的
  `refactor.extract`／`refactor.inline` kind，做事的是該語言的 server。內建的
  `editor.action.refactor` 開的是選單，而選單裡那一項每個 server 講法都不同，快捷鍵綁不到。
- **`Move to New File`／`Change Signature`／`Implement Interface`**：同一個形狀再三個，
  從命令面板叫。Change Signature 游標要在參數上；Implement Interface 要先有一個編不過的
  斷言（Go 是 `var _ Shape = Triangle{}`）。

### 檢視

- **縮排上色**（設定）：每層縮排的空白塗底色，四色循環，**填不滿一層的空白另外標色**。
  內建的 indent guides 回答「block 從哪開始」，上色回答「我在第幾層」。
- **Gutter 圖片預覽**（設定）：某行提到的圖檔存在就在 gutter 放縮圖。
- **TODOs 檢視**（設定）：檔案總管多一個面板，列出整個 workspace 的 `TODO`／`FIXME`／
  `HACK`／`XXX`／`BUG`。只在面板顯示時才掃描，排除規則沿用 `files.exclude`／`search.exclude`。
- **`Syntax Colors for This Language`**：列出目前這個檔的文法能產生的全部 TextMate scope，
  做成一份可以直接複製的 `editor.tokenColorCustomizations.textMateRules`。顏色欄位是
  `#RRGGBB` 佔位字串，所以整份貼上去不會改變任何顏色。

## 快捷鍵

| 命令                               | mac               | Windows／Linux     | 何時生效            |
| ---------------------------------- | ----------------- | ------------------ | ------------------- |
| `Toggle Bold`                      | `cmd+b`           | `ctrl+b`           | markdown 家族       |
| `Toggle Italic`                    | `cmd+i`           | `ctrl+i`           | markdown 家族       |
| `Continue List`                    | `enter`           | `enter`            | markdown 家族、yaml |
| `Indent List Item`                 | `tab`             | `tab`              | markdown 家族       |
| `Outdent List Item`                | `shift+tab`       | `shift+tab`        | markdown 家族       |
| `Extract Variable`                 | `cmd+alt+v`       | `ctrl+alt+v`       | 編輯器有焦點        |
| `Inline Variable`                  | `cmd+alt+shift+v` | `ctrl+alt+shift+v` | 編輯器有焦點        |
| `Go to Next Changed File`          | `cmd+alt+z`       | `ctrl+alt+z`       | 有 git              |
| `Go to Previous Changed File`      | `cmd+alt+a`       | `ctrl+alt+a`       | 有 git              |
| `Revert Selected Changes and Save` | `alt+q`           | `alt+q`            | 有 git、檔案        |

其餘命令沒有預設快捷鍵，從命令面板叫，或自己綁：`poly.copyPathWithLine`、
`poly.insertTableOfContents`、`poly.runFile`、`poly.moveToNewFile`、`poly.changeSignature`、
`poly.implementInterface`、`poly.syntaxColors`、`poly.refreshTodos`。

## 設定

| 設定                              | 預設     | 作用                             |
| --------------------------------- | -------- | -------------------------------- |
| `poly.indentTint.enabled`         | `false`  | 縮排上色                         |
| `poly.imagePreview.enabled`       | `false`  | gutter 圖片縮圖                  |
| `poly.referencesCodeLens.enabled` | `false`  | `N refs`／`N impls`／`N methods` |
| `poly.protobufCodeLens.enabled`   | `false`  | `.proto` → 生成的 Go             |
| `poly.runCodeLens.enabled`        | `false`  | `run \| debug`                   |
| `poly.markdownMermaid.enabled`    | `false`  | preview 裡畫 mermaid             |
| `poly.postfixCompletion.enabled`  | `false`  | `.if`／`.for` 之類的展開         |
| `poly.todo.enabled`               | `false`  | 檔案總管的 TODOs 面板            |
| `poly.todo.tags`                  | 五個標籤 | TODOs 面板找哪些字               |

markdown 的 Enter／Tab／粗體斜體與 `Copy Path with Line Numbers`、重構命令沒有開關：它們
只在你按下去時才做事。

## 設計理由

搬到 `dev_docs/vscode-syntax`。這裡只寫結論。
