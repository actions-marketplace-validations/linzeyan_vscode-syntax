# Poly Editor

編輯器端的便利功能，**沒有 CI 對應物**的那些——所以它們不在
[poly-lsp](https://github.com/linzeyan/vscode-syntax/tree/main/extensions/lsp) 裡：
poly-lsp 的失敗模式是「daemon 沒起來就整個失效」，而且它的 VSIX 是分平台六份，
純 TypeScript 的功能沒有理由被打包六次。

這個 extension 不需要 poly binary，也不需要 poly-lsp。

## 功能

### Poly: Copy Path with Line Numbers

複製 `路徑:行號`。有選取多行時是 `路徑:42-51`，否則是游標所在的 `路徑:42`。
路徑相對於 workspace folder，一律用 `/`。

VSCode 內建的 **Copy Relative Path** 只到路徑為止，`:42` 是唯一的差別——但那一截
才是重點：`src/lib.rs:42` 正是 `rg` 印的形狀、CI annotation 連過去的形狀、終端機
能點的形狀，也是 poly 自己的診斷輸出的形狀。貼出來的參照跟這些工具吃的是同一個
契約，讀的人不必先翻譯。

命令面板或編輯器右鍵選單都可以叫它。預設沒有綁快捷鍵——要的話自己在
`keybindings.json` 綁 `poly.copyPathWithLine`。

### Poly: Insert Table of Contents

在游標處插入目錄，並用 `<!-- poly:toc -->` ／ `<!-- /poly:toc -->` 兩個標記把它框起來，
所以再跑一次是**就地更新**而不是又插一份。列 H2 到 H6——H1 是文件標題，目錄就在它下面，
不需要一條連回自己的連結。

- 錨點用的是 **VSCode 自己的 slug 規則**（照它 markdown preview 出貨的那份轉寫），
  所以連結在寫它的那個編輯器裡一定跳得到。GitHub 的規則很接近但不完全相同（差在某些
  全形標點），兩邊都要能跳的文件請用 ASCII 標題。
- YAML front matter 裡的 `#` 是註釋、fenced code block 裡的 `#` 是程式碼，兩者都不會
  被當成標題。
- 不會在存檔時自動更新。目錄什麼時候變，你自己說了算。

### Poly: Toggle Bold ／ Toggle Italic

`cmd/ctrl+b` 與 `cmd/ctrl+i`，只在 markdown 檔生效（所以 `cmd+b` 在其他檔案照樣是
VSCode 的側邊欄開關）。沒有選取時作用於游標所在的單字。

產生的是 `**bold**` 與 `_italic_`——正是 `poly fmt` 對 markdown 正規化出來的那兩種，
所以按下去的結果不會被下一次存檔改掉。

「markdown 檔」指的是整個 markdown 家族：`markdown`，加上 VSCode 1.120 的
`prompt-basics` 從它分出去的 `skill`／`prompt`／`instructions`／`chatagent`
（`SKILL.md`、`*.prompt.md`、`*.instructions.md`、`.claude/agents/**`、
`.claude/rules/**` 等）。`Insert Table of Contents` 認的也是這一組。

### Enter：清單接續

在清單項目上按 Enter 接出下一項，**有序清單的號碼會遞增**（`1.` → `2.`）。整份都寫成 `1.`
的清單維持 `1.`——CommonMark 本來就把它算成 1、2、3，`poly fmt` 兩種寫法都保留，改寫別人選
的風格不是 Enter 的事。巢狀清單各數各的。任務項不管原本打勾沒有，接出來的都是 `- [ ]`。

**空的項目按 Enter 是結束清單**：往外退一層，退到最外層就把 marker 清掉。這是所有人本來就
在用的「連按兩次 Enter」，少了它每次都要自己回頭刪一個 marker。

yaml 也接管，但只認 sequence 的破折號：`>` 在 yaml 是 folded block scalar、`1.` 只是字串，
照 markdown 的規矩接下去會弄壞檔案。

poly-syntax-highlight 用語言設定檔也做了一份接續（`onEnterRules`）。裝了 poly-editor 的話
Enter 由這裡接管，那份是單獨安裝 syntax 時的退路——它接不出遞增的號碼，也結束不了清單，因為
語言設定檔只能接一段固定文字。順帶一提，那份還有一個這裡沒有的毛病：`onEnterRules` 在該行
還沒 tokenize 完之前會被整條跳過，所以大檔剛開啟的那一瞬間按 Enter 是沒有接續的。

### Tab ／ Shift+Tab：清單縮排

游標停在清單項目的內容起點或更左邊時，`tab` 把整項推進一層，`shift+tab` 退回上一層。
一旦游標已經在文字裡，Tab 就還給打字——這條界線跟 markdown-all-in-one 的一樣。

**一層不是一個 tab stop，是上一項內容開始的那一欄**：`- x` 的內容在第 2 欄、`1. x` 在第
3 欄、`10. x` 在第 4 欄。這正是 `poly fmt` 正規化出來的縮排（實測：`1.` 底下縮四格的子項
會被改成三格），所以按出來的層級不會被下一次存檔改掉——跟粗體選 `**` 是同一條理由。用
`editor.tabSize` 就會兩邊打架。

界線之外的每一種情況都原封不動轉發給內建的 `tab`／`outdent`：不是清單、有選取、
補全清單開著、snippet 進行中、inline suggestion 等著被接受（Copilot 的 Tab 不會被搶走）。
清單的第一項也一樣——它沒有可以縮進去的上一層，硬縮只會產生一段 `poly fmt` 會清掉的空白。

### 引用計數 CodeLens

每個宣告上方一行 `11 refs`／`1 ref`／`no refs`，點下去開引用清單。interface 與它的
方法再多一顆 `1 impl`／`3 impls`／`no impls`，點下去列出實作它的型別；反過來，具體
型別與它的方法拿到 `1 interface`／`2 interfaces`，點下去到它滿足的那個 interface。
方法寫在型別外面的語言（Go）再多一顆 `4 methods`。

**poly 不做任何分析。** 它問編輯器要 `vscode.executeReferenceProvider` 的結果，編輯器
去問該語言已經註冊的 provider——Go 的話那就是 poly-lsp 前面那層轉給 gopls 的 proxy——
poly 只負責數與畫。所以這不是「poly 實作了引用搜尋」，是把手上已經有的答案交出去。

副作用是它**與語言無關**：任何有 reference provider 的語言都會亮。VSCode 內建只有
TypeScript 有這個 lens，其他語言都沒有。

- **每個語言都有，沒有名單**（2026-09-04 起）。以前是一份寫死的語言 id 清單，而那份清單
  是在猜你裝了什麼——python、typescript、java 全都有好好的 reference provider，卻被漏在
  外面。現在改成直接問：拿檔案裡前三個宣告去問一次 `executeReferenceProvider`，一個位置
  都答不出來就整份檔案不畫。`includeDeclaration: true` 之下，**會回答的 provider 至少會
  回宣告自己**，所以「零個位置」＝「沒人註冊」，而不是「沒人引用」——後者值得一條
  `no refs`，前者只值得閉嘴。TS／JS 現在也有了：VSCode 自己那條預設是關的，漏掉它們等於
  大多數人根本看不到 lens；真的兩條都開就會看到兩個數字，那是看得見也關得掉的。
- 只算**檔案自己的宣告與它們的方法**，函式裡的區域變數不算：那些的引用本來就在畫面上，
  一個區域變數一條 lens 只會把真正該看的埋掉。struct field 也不算——「誰寫這個欄位」
  跟「這個型別到底有沒有人用」是兩個問題。
  - **2026-09-17 修正：深度不足以表達上面那句話。** 在真的 extension host 裡量過：
    Pylance 把函式的**參數與區域變數**當成該函式的 `Variable` 子符號回報（`def helper(value)`
    的 `value`、函式裡的 `total`、`obj` 全都是深度 2），TypeScript 則把 arrow function 的
    local 掛在那個 arrow 所指派到的 `Variable` 底下。兩邊都會拿到一條 `N refs`。現在改成
    **只往「裝得下宣告」的容器裡面走**（Module／Namespace／Package／Class／Enum／Interface／
    Object／Struct），而不是照深度一律往下——`Object` 是 rust-analyzer 的 `impl` 區塊，
    漏掉它會讓 Rust 的每個方法都失去 lens。
- 數字**不含宣告自己**。`executeReferenceProvider` 是帶 `includeDeclaration: true` 問的，
  不扣掉的話沒人用的東西會顯示成 `1 ref`——而那正是這個計數最該讓人看見的一種。
- **點下去分三種，因為 `N refs` 其實是三個手勢。** 沒人引用就沒地方去，那條 lens 是純文字；
  **只有一個就直接跳過去**，為了一筆結果開一個清單是多按一次；兩個以上開檔案總管裡的
  **References** 面板——peek 一碰編輯器就關掉，清單要讀就該留著。
- **那個面板是 poly 自己的，為的是兩個欄位。** 內建的 `references-view` 每列只印一行原始碼，
  檔名在上面那層；要回答「這四十筆裡哪一筆是介面上的那個」或「這是呼叫還是宣告」，需要的是
  **行號**與**它落在哪個符號裡**，而那兩樣都不在畫面上。`TreeDataProvider` 的列是它自己的，
  沒有「幫別人的樹加一欄」這種 contribution point，所以 poly 只能自己有一棵。
  - 列的格式是 `<行號>  <該行原始碼>`，右側淡色再標 `method Handle`／`func main`／
    `var config` 這類**最內層**的符號。最內層而不是最外層：某個檔案裡每一列都在同一個 class
    裡面，標 class 等於什麼都沒說。
  - 落在任何符號之外（import 區塊、頂層敘述、沒有 symbol provider 的語言）就留白，不會硬
    標一個 `file`——那是在發明一個 outline 裡根本沒有的層級。
  - 面板平常不在，有結果才出現。
  - 每個檔案問一次 outline，上限 60 個檔案；超過的列仍然有行號，少的只是符號那一欄。
- **`N impl` 掛在 interface 與它的成員上，`N interfaces` 掛在具體型別與方法上。** 一顆 lens
  只掛一個命令，所以 `1 ref | 1 impl` 其實是兩顆共用同一行的 lens。同一個
  `textDocument/implementation` 兩個方向讀，只有字不一樣——「2 impls」掛在 struct 上會變成
  「這個 struct 有兩個實作」，那不是一句話。
  - **每個方向由每個語言各自賺到。** 實測（2026-09-21）：gopls 在 `type Circle struct` 上答
    得出 `Shape`，**TypeScript 在 `class Circle implements Shape` 上什麼都不答**，而
    `buf lsp serve` 兩個方向都不答——無條件畫的結果是 TS 每個 class 一條永久的
    `no interfaces`、`.proto` 每個 service 與 rpc 一條永久的 `no impls`。現在是：某個語言的
    provider 在某個方向答出過一次，那個方向才開，而且**只記 yes 不記 no**（一整檔沒人實作的
    interface 跟「這語言問不到」長得一樣，記成 no 會讓之後長出實作的專案再也看不到）。
- **`N methods` 不問任何人**，它就在畫 outline 用的那份符號樹裡。gopls 把 Go 的方法報成頂層
  的 `(Circle).Area`，`buf lsp serve` 把 rpc 報成 `greet.v1.Greeter.SayHello`——兩種都是
  「方法在型別外面」，也就是唯一需要一個數字的情況。方法就寫在型別裡面的語言（TypeScript、
  Java、Python）不畫：數一個已經在畫面上的東西是裝飾。
- `poly.referencesCodeLens.enabled` 可關（全部一起）。編輯器只解析**看得見**的那幾條
  lens，所以成本是「畫面上幾個宣告」而不是「檔案裡幾個宣告」。

### Postfix completion

在句尾打 `.` 再打關鍵字：`err.if` 展開成 `if err != nil { }`（Go）、`if (err) { }`
（TypeScript）、`if err:`（Python）。涵蓋 go／rust／swift／typescript／javascript
（含 react 變體）／python／lua／c／cpp——**每個有敘述句的語言**。資料格式沒有，JSON 裡
`if` 沒有東西可以展開。

- **這是文字重排，不是語意分析。** poly 只讀 `.` 左邊那串字元、把它塞進模板、交給編輯器
  自己的 snippet 引擎——跟隔壁那個 markdown 粗體切換同一種東西。它不知道 `err` 是不是
  error、有沒有型別、展開之後編不編得過。**那份無知正是重點**：正因為什麼都不知道，同一
  份表才蓋得住每個語言，而這也是它跟「語言功能」的分界（01 A6 擋的是分析，不是模板）。
- **表達式邊界是往左掃出來的**：成員鏈整條算、括號與字串整組算、遇到運算子就停。所以
  `x + foo(a, b)[0].if` 抓到的是 `foo(a, b)[0]`，不是前面那個 `x +`。
- **排在 language server 的答案後面**（`sortText`）。叫 `iffy` 的成員是關於程式的真答案，
  模板不是；要等你打到沒有成員能匹配，它才會浮上來。
- gopls 沒有 postfix completion，這是 Tooltitude 清單裡唯一一項「poly 代管的東西都不提供」
  的功能。`poly.postfixCompletion.enabled` 可關。

### Poly: Extract Variable ／ Inline Variable

`cmd/ctrl+alt+v` 把選取的運算式抽成變數，`cmd/ctrl+alt+shift+v` 把游標所在的變數 inline
回去。**每個語言都通用**，因為問的是 LSP 標準的 `refactor.extract`／`refactor.inline`
code action kind——真正做事的是該語言的 server，poly 只負責挑。

- **`editor.action.refactor` 本來就有，缺的是「直接到」。** 它開一張選單，選單內容每個語言
  不一樣，而你要的那一項每個 server 講法都不同：gopls 是 `Extract variable`、rust-analyzer
  是 `Extract into variable`、clangd 是 `Extract subexpression to variable`、TypeScript 是
  `Extract to constant in enclosing scope`。快捷鍵綁不到任何一個，所以那個手勢永遠是「三個
  按鍵加讀一次選單」。
- **會過濾掉不是變數的那些。** `refactor.extract` 同時也蓋 `Extract function`／
  `Extract method`；一個叫 Extract Variable 的命令安靜地抽出一個函式，比什麼都不做更糟。
  沒有任何一項提到變數時，才把同 kind 的全部列出來讓你選——沒量過的講法應該讓你多按一次，
  不該讓功能消失。
- 剛好只有一項就直接套用，多於一項才跳 QuickPick。
- 選取範圍是空的時候用游標所在的那個字。再寬就是 poly 在決定「運算式從哪裡開始」，那是語言
  的工作，不是 poly 的。

### Poly: Move to New File ／ Change Signature ／ Implement Interface

同一個形狀再三個：問一種標準的 code action kind，挑出名字對得上的那幾項，套用。做事的一樣
是該語言的 server。三個都沒有預設快捷鍵，從命令面板叫。

- **Move to New File** 問 `refactor.extract`，挑 `toNewFile`。**不是**問標準的
  `refactor.move`——實測 gopls 對那個 kind 回 null，這個手勢它歸在
  `refactor.extract.toNewFile`（`Extract declarations to new file`）底下。
- **Change Signature** 在游標原位問 `refactor.rewrite`。沒有「改簽名」對話框這種東西：
  gopls 把它拆成 `Move parameter left`、`Split parameters into separate lines`、參數沒用到
  時的 `Remove unused parameter`，各自是一條 code action。**游標要在參數上**——在函式名上
  問同一個 kind，gopls 回 null。
- **Implement Interface** 問 `quickfix`，挑「補上缺的方法」那條（gopls 說
  `Declare missing methods of X`、rust-analyzer 說 `Implement missing members`、TypeScript
  說 `Implement interface 'X'`）。**要先有一個編不過的斷言**，例如 Go 的
  `var _ Shape = Triangle{}`：server 是對著診斷提供這個 quickfix 的，沒有診斷就沒有東西可
  挑。poly 不替你決定「你想實作哪個 interface」——那是分析，01 A6 擋掉的正是它。
- 這三個**沒有 fallback**，另外兩個有。`refactor.inline` 整個 kind 就是那件事，所以沒量過的
  講法讓你多按一次選單是對的；`quickfix` 是每個 server 丟所有修正的那個桶子，一個叫
  Implement Interface 的命令跑出 `Add missing import` 比什麼都不做更糟。

### `run | debug` CodeLens

程式進入點上方一行 `run | debug`——Go／Rust／C／C++／Java 的 `main`、C# 的 `Main`、
Python 的 `if __name__ == "__main__"`、shell script 的 shebang。
`poly.runCodeLens.enabled` 可關。

**`run` 就是跑起來，不經過 debugger。** 存檔，然後在一個叫 `Poly Run` 的整合終端機裡、
以該檔所在目錄為工作目錄下一行命令：

| 語言        | 命令                                                                               |
| ----------- | ---------------------------------------------------------------------------------- |
| go          | `go run .`                                                                         |
| rust        | `cargo run`                                                                        |
| python      | `python3 "<檔名>"`（Windows 是 `python`——那裡的 `python3` 是會打開 Store 的 stub） |
| shellscript | `<shebang 指定的直譯器> "<檔名>"`                                                  |

Go 與 Rust 吃的是目錄不是檔案，因為 main package 很少只有一個檔，`go run main.go` 會在
隔壁檔案定義的第一個符號上就失敗。shell 照 shebang 挑直譯器而不是一律 bash：zsh 腳本在
bash 下是另一種語言，而它們的差異（陣列從 1 開始、word splitting、`setopt`）恰好都是安靜
壞掉而不是大聲報錯的那種。終端機只有一個、重複使用，而且**不搶焦點**——要看的是輸出，
游標每按一次就跳出編輯器是要用手搬回來的。

**要先編譯的語言只有 `debug`**：C、C++、Java、C# 的進入點 poly 找得到，但要跑起來得先編，
而編譯的旗標、輸出路徑與 toolchain 是 poly 不該有意見的東西。知道怎麼建置它們的是那個
extension，按鈕就該給它。

**`debug` 一律交給你裝的 debug extension**，Go 就是 `golang.go` 的 delve。
`contributes.debuggers` 一個都沒有，DAP 一行都沒有。有 `launch.json` 時它等於按 F5，
沒有時由該語言的 debug extension 給 active file 一份動態設定——後者正是這條 lens 存在的
理由，也是「我在看的這個檔」跟「F5 會跑什麼」剛好是同一件事的情況。

**Python 與 shell 的進入點不是宣告**，所以它們兩個不走符號走文字：Python 找
`if __name__ == "__main__"`（一個敘述句，沒有任何 symbol provider 會把它報成宣告），
shell 找第一行的 shebang。一個檔最多一顆，而且**只認這一條規則**——否則一個 Python 檔
會在 guard 上有一顆、在它呼叫的 `def main` 上再有一顆。沒有 guard 的 `.py` 跟沒有
shebang 的 `.sh` 都不畫：前者跑起來什麼都不做，後者通常是被 source 進去的函式庫。

### protobuf → 生成的 Go

`.proto` 裡 `message`／`enum` 上方一行 `go type`，`service` 上方 `go server`、`go client`，
點下去跳到 protoc 生出來的 Go 宣告。`poly.protobufCodeLens.enabled` 可關。

- **這是命名規則，不是分析。** `message HelloRequest`（package `greet.v1`）在
  `greet.pb.go` 裡就叫 `HelloRequest`，巢狀的 `HelloRequest.Nested` 叫
  `HelloRequest_Nested`，`service Greeter` 生出 `GreeterServer` 與 `GreeterClient`——因為
  protoc-gen-go 的定義就是這樣。poly 組出名字，去問已經在跑的 Go server 那個名字在哪。
- proto 這邊的宣告來自 `buf lsp serve`（poly 本來就把 `.proto` 路由給它），Go 那邊來自替
  生成檔回答的 server。生成檔是**照檔名找一次、整份符號讀一次**，不是每個 message 去做一次
  workspace 搜尋。
- **找不到就不畫**，不畫一顆按了沒反應的。所以「還沒 generate」跟「生在 workspace 外面」
  都是安靜的。
- 只認 protoc-gen-go 與 protoc-gen-go-grpc。connect-go 的 `greet.connect.go` 之類不碰——
  跳錯地方比沒有 lens 更糟，而那些從 `.proto` 本身看不出來。
- **rpc 上方另有一顆 `N impls`**，點下去就是寫在 Go 裡的那些 handler。`buf lsp serve` 不宣告
  implementation provider，但回答這題的本來就不該是它：rpc 是生成的 `GreeterServer` 上的一個
  method，而那對 Go 的 server 只是個普通問題。poly 把 `greet.v1.Greeter.SayHello` 組成
  `GreeterServer.SayHello`、在生成檔裡找到那個位置、在那裡問一次 implementation——組名字的是
  poly，找 handler 的是 gopls。

### 跨檔案 next／previous change ＋ Revert and Save

`cmd/ctrl+alt+z` 跳到下一個有改動的檔案，`cmd/ctrl+alt+a` 跳到上一個，`alt+q` 把游標
所在的那個 hunk 還原並存檔。

VSCode 內建的 **Go to Next/Previous Change**（`workbench.action.editor.nextChange`／
`previousChange`）處理的是「同一個檔案裡的下一處改動」；**跨檔案那一步沒有內建命令**，
而那正是 review 一個 branch 時按最多次的一步。要單檔的那組，直接在
`keybindings.json` 綁內建命令即可，這裡不重做。

- 順序是**路徑排序**，不是 git 回報的順序——同一顆按鍵按兩次得走同一條路，git 的順序
  不保證，而「下一個」有時候往回跳比沒有這個命令還糟。
- 游標所在的檔案**不必**在清單裡：從一個沒改動的檔案開始 review 是常態，所以會落在
  該方向上最近的那一個，而不是跳回清單開頭。
- 兩端都會繞回去。停在最後一個只會讓按鍵看起來壞掉，而且沒地方說明為什麼。
- 同一個檔案同時有 staged 與 unstaged 改動時只算一站。
- 開檔後會落在該檔的第一處（往回時是最後一處）改動上。剛開的檔案 quick diff 是非同步
  算出來的，所以這裡會短暫重試——否則第一次按下去會停在檔案開頭，那是我們唯一確定
  改動不在的地方。
- **Revert and Save** 是 `git.revertSelectedRanges` ＋存檔兩件內建動作合成一個手勢。
  只還原不存檔的話，真正算數的是下一次存檔，在那之前磁碟上的檔案跟編輯器裡看到的不一致。

需要內建的 git extension；它被停用時會講出來，不會靜靜地沒反應。

### 縮排上色

把每一層縮排的空白塗上底色，四色循環。VSCode 內建的 `editor.guides.indentation`
畫的是線，回答「這個 block 從哪開始」；上色回答的是另一個問題——「我現在在第幾層」，
那是深巢狀 YAML 與 Python 裡真正會問的。

**填不滿一層的空白另外標色**，因為那正是「縮排改到一半」的樣子，而它在其他任何地方
都看不出來。層寬取編輯器解析後的 `tabSize`（語言、檔案、`editor.detectIndentation`
都算進去了），所以跟你眼睛看到的寬度一致。

`poly.indentTint.enabled` 可關。顏色是 theme color，用
`workbench.colorCustomizations` 蓋 `poly.indentLevel1`～`4` 與 `poly.indentPartial`。

只畫**可見範圍**——整份檔案的每一層縮排是幾千個 range，而沒有人在看它們。

### markdown preview 的 mermaid 圖表

markdown preview 裡的 ```mermaid fence 畫成圖，配色與字型都從編輯器主題推導。

**這一項是有條件的：VSCode 1.135 起內建就有 `mermaid-markdown-features`，那時候 poly
會整個讓開。** 判定的方式是問 extension 在不在（`vscode.mermaid-markdown-features`），
不是比對版本號——問題本來就是「有沒有別人已經在畫這些 fence」，而一顆 fence 被兩個
renderer 畫不會比較好看：先替換掉元素的那個贏，後到的畫進一個沒人在看的節點。所以
poly 的 `engines.vscode` 是 `^1.85.0`，而這個功能實際生效的區間是 **1.85 到 1.134**。

- **fence 的判定跟內建同一條規則**：`\bmermaid\b`、大小寫不敏感。所以 ```mermaid-example
  也會被畫——那是 mermaid 官方文件用來「講解」圖表原始碼的 fence，照理不該畫。**明知有
  這個毛病還是照抄**：poly 在這裡是內建的替身，同一份文件在你升上 1.135 的前後必須畫出
  一樣的東西，升級之後才不會有 fence 突然不見。
- **主題不是 mermaid 內建的那幾套**：從 preview 的 `--vscode-*` CSS 變數推出 mermaid
  `base` 主題的變數——背景、線條、節點、註記、錯誤色與圖表色盤，還有
  `--vscode-font-family`／`--vscode-font-size`——對應表跟內建同一份。字型不只是外觀：
  mermaid 會量它排出來的文字，同一張圖用 Trebuchet 16px 和用編輯器字型畫，**大小不一樣**。
- **跟內建對照跑過差分**（`make mermaid-diff`）：74 個案例——**mermaid 11.17 註冊的 37 種
  圖表全部各一個**（不是挑的，是從它 `registerLazyLoadedDiagrams` 的清單反出來）、fence 與
  `:::mermaid` 容器的各種寫法、跳脫與 `%%{init}%%` 設定。markdown 這一層（容器數、容器裡的
  原始碼、其他語言的 fence class）**全等**，37 種圖表裡 poly 畫得出 36 種、寬高到像素一致。
  差異只剩三筆：zenuml（見下）、`layout: elk`（見下），以及 `info` 圖——那張圖畫的內容
  就是 mermaid 版本號，兩邊分別是 11.17.0 與 11.17.2。
- **四套主題各跑一次，而且比對顏色**：dark／light／high contrast／high contrast light。
  顏色是這件事唯一的重點——兩邊都不是拿到調色盤，而是各自從 `--vscode-*` 經自己的 fallback
  串推導，所以同一張對應表可能在深色一致、淺色分岔。比的是整張 SVG 用到的顏色集合（與 DOM
  順序無關）。結果：**四套主題下、上面那三筆以外的 71 個案例連顏色都相同**。
- **1.85 與 1.120 上也量過**：內建只有 1.135 以上才存在，所以上面那組比對證明的是 poly 在
  它會讓開的版本上畫得對。差分因此另外跑 poly 在 **1.85**（`engines.vscode` 的下限）與
  **1.120**，對照 poly 在 1.138 的結果——**形狀、標籤、尺寸零差異**。1.85 有 54 個案例顏色
  不同，而那是編輯器的差別不是 poly 的：1.85 比 1.138 少定義 **281** 個 `--vscode-*`、另有
  50 個值不一樣。實例是 `--vscode-chart-line`（1.138 為 `#236b8e`）在 1.85 根本不存在，
  fallback 於是落到 `--vscode-editorWidget-border`；`--vscode-charts-blue` 則是值自己從
  `#3794ff` 改成 `#59a4f9`。1.120 少 85 個變數、7 個值不同，顏色仍然完全一致。（1.85 原本
  還有一筆：帶 `click` 指令的圖整張畫不出來，因為 mermaid 走 `URL.canParse`，那是
  Chromium 120 才有的 API。已補 polyfill。）
- **`zenuml` 是唯一畫不出來的類型**：它不是 mermaid 本體的圖表，是內建額外註冊的
  external diagram（`@mermaid-js/mermaid-zenuml`）。沒有跟進的理由是它相依 `@zenuml/core`
  ——9.7 MB，而且會把 React、antlr4、highlight.js、marked 一整串拉進 preview bundle，
  而整個 poly-editor VSIX 現在是 963 KB。
- **圖表原始碼是當成文字塞進 DOM 的**，`&`／`<`／`>`／`"` 在 extension host 這側就escape
  掉。preview 的 CSP 是 `default-src 'none'`、script 只認 nonce，但一張圖能不能寫 HTML
  進 preview 不該賭在 CSP 上。
- **畫不出來的時候原始碼留在畫面上**，錯誤訊息接在下面。mermaid 自己的作法是把圖換成一顆
  炸彈圖示，那比「哪一行不合法」說得少（`suppressErrorRendering` 關掉它）。
- 渲染在 webview 裡（`markdown.previewScripts`），因為 mermaid 要量它排出來的文字，
  而 extension host 沒有 DOM。代價是 VSIX 多了 mermaid.js 那一份 bundle（3.5 MB，
  打包後約 1 MB）。
- **mermaid 釘在 `^11`，不是最新的 12**：12.0.0 把 `elkjs` 變成直接相依，而 elkjs 是
  EPL-2.0——poly 對出貨物的授權 allowlist 上沒有它。實測把它排除掉（`--external:` 或
  alias 成 stub）會讓**每一張圖**都畫不出來，因為 mermaid 在 render 路徑上就會碰到那個
  模組；11.x 則根本沒有這個相依，而且對沒註冊的排版演算法是 warn 後退回 dagre。所以
  `layout: elk` 的圖在這裡會用 dagre 畫出來，不會失敗。內建另外註冊的 `tidy-tree` 排版
  **有跟進**（`@mermaid-js/layout-tidy-tree`，MIT、242 KB、只相依已經在 bundle 裡的 d3），
  畫出來跟內建一模一樣；擋住的只有 elk 一個，理由是授權不是體積。
- `poly.markdownMermaid.enabled` 可關，關掉會順手 refresh 已經開著的 preview。

### Gutter 圖片預覽

某一行提到的圖片檔存在的話，就在該行的 gutter 放一張縮圖。路徑先相對於該檔案自己的
目錄找，再相對 workspace root 找（所以 `./logo.png` 與寫成 server 絕對路徑的
`/assets/logo.png` 都會中）。

刻意不寫語法解析器：markdown、HTML、CSS 與一個純字串各有各的寫法，而**檔案存不存在
才是真正的過濾器**。認錯一次的代價是一個 `stat`，漏掉一次的代價是這個功能。

`poly.imagePreview.enabled` 可關。

### TODOs 檢視

檔案總管裡多一個 TODOs 面板，列出整個 workspace 的 `TODO`／`FIXME`／`HACK`／`XXX`／
`BUG`（`poly.todo.tags` 可改）。點一條就跳到那一行那一欄。

- 規則只有「大寫、整個字」。再聰明就得認得每種語言的註釋語法，而**認錯的後果是有標記
  卻沒被列出來**——那比多列一個寫在字串裡的還糟。
- 只在面板真的顯示時才掃描；存檔會重掃。沒開這個面板的 session 不該替它付錢。
- 掃描有上限（4000 個檔案、單檔 512 KB），而且**上限有講出來**：面板標題會寫
  「stopped at 4000 files」，所以「清單很短」跟「清單被截斷」不會長得一樣。
- 排除規則沿用你已經設好的 `files.exclude` 與 `search.exclude`。

## 授權

MIT，見 VSIX 內的 `LICENSE`。
