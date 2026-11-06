## ADDED Requirements

### Requirement: 憑證欄位的布林值與純插值組合值不視為 Secret

Secret 掃描的 `credential_assignment` 類別 MUST 把下列兩種值判為不含憑證：

1. 未加引號的布林字面值 true 或 false（與欄位名稱一樣不分大小寫），且其後緊接行尾、空白、引號、逗號、分號、右大括號、右括號或右中括號。
2. 只由變數插值與分隔符號組成的值：每段插值的形式為 `${...}`，插值內可含識別字、成員存取與以識別字為引數的函式呼叫；插值之外只出現 `=`、`.`、`:`、`/`、`-`、`_`、`@`、`#`、`?`、`&`、`+`、`|` 與包住整個值的引號或反引號，不出現任何字面英數字。

這兩種排除 MUST 在原始文字與 stream-json 的 JSON 轉義形式（引號、反斜線與換行被轉義）下同樣成立。本 Requirement 不改變既有規則對 JSON 轉義形式中其他值的判定。這個排除只看值本身；欄位名稱的比對方式（包括以憑證詞結尾的複合名稱）MUST 維持不變，MUST NOT 依檔名、路徑或欄位名稱略過掃描。值帶有任何其他字面內容時，MUST 繼續判為 Secret。其他 Secret 類別（provider key、cloud access key、private key、bearer token、JWT）的判定 MUST NOT 受此規則影響。

掃描是同步、無 I/O 的純判定，沒有逾時、取消或重試語意；命中後的抑制與 evidence gate 行為沿用既有規則。

#### Scenario: 複合欄位名稱指派布林值

- GIVEN 一行輸出含有以 cookie 結尾的複合欄位名稱
- AND 該欄位以等號指派未加引號的 false，其後緊接逗號
- WHEN 執行 Secret 掃描
- THEN 該行 MUST NOT 判為任何 Secret 類別

#### Scenario: 大寫的布林值

- GIVEN 密碼欄位以冒號指派全大寫、未加引號的 TRUE，其後緊接右大括號
- WHEN 執行 Secret 掃描
- THEN 該行 MUST NOT 判為任何 Secret 類別

#### Scenario: 加引號的布林值仍是字面值

- GIVEN 密碼欄位的值是以雙引號包住的 false 五個字元
- WHEN 執行 Secret 掃描
- THEN 該行 MUST 判為 `credential_assignment`

#### Scenario: 以布林開頭並緊接其他字元的值

- GIVEN 密碼欄位的值以 false 開頭，其後直接接上其他英數字元
- WHEN 執行 Secret 掃描
- THEN 該行 MUST 判為 `credential_assignment`

#### Scenario: 多段插值組成的 cookie 標頭值

- GIVEN 一行程式碼把反引號樣板指派給以 cookie 結尾的欄位
- AND 樣板的值由三段變數插值與等號、句點組成，其中一段是以識別字為引數的成員函式呼叫
- AND 插值之外沒有字面英數字，值之後以分號接上 cookie 屬性
- WHEN 執行 Secret 掃描
- THEN 該行 MUST NOT 判為任何 Secret 類別

#### Scenario: 插值組合中夾帶字面值

- GIVEN 憑證欄位的值是一段變數插值、等號，之後接上一段至少 4 個字元的字面英數字
- WHEN 執行 Secret 掃描
- THEN 該行 MUST 判為 `credential_assignment`

#### Scenario: 插值內含字面引數

- GIVEN 憑證欄位的值是一段變數插值，插值內的函式呼叫以引號包住的字面字串為引數
- WHEN 執行 Secret 掃描
- THEN 該行 MUST 判為 `credential_assignment`

#### Scenario: JSON 轉義形式下的排除

- GIVEN「複合欄位名稱指派布林值」「大寫的布林值」或「多段插值組成的 cookie 標頭值」的原始行
- WHEN 該行先以 JSON 字串轉義後，放進 stream-json 工具結果事件再執行 Secret 掃描
- THEN 該事件行 MUST NOT 判為任何 Secret 類別

#### Scenario: JSON 轉義形式下的反例

- GIVEN「以布林開頭並緊接其他字元的值」或「插值組合中夾帶字面值」的原始行
- WHEN 該行先以 JSON 字串轉義後，放進 stream-json 工具結果事件再執行 Secret 掃描
- THEN 該事件行 MUST 判為 `credential_assignment`

#### Scenario: 已知限制維持命中

- GIVEN 未轉義的原始文字中，以憑證詞結尾的常數以引號指派一段一般字串字面值
- WHEN 執行 Secret 掃描
- THEN 該行 MUST 判為 `credential_assignment`

#### Scenario: 命中時沿用 fail-closed 行為

- GIVEN Qwen 的原始 stdout 含有任一行仍須命中的憑證值
- WHEN adapter 執行 capture
- THEN 原始 stdout MUST 被抑制，不得保存
- AND evidence gate MUST 回報 `raw_output_contains_secret`
- AND effective verdict MUST 為 `INCOMPLETE`

#### Scenario: 既有 Secret 掃描行為不回歸

- GIVEN 本規則生效
- WHEN 執行既有的 Secret 掃描回歸案例（變數插值樣板、測試假值、bare null、實際字面值、各 Secret 類別）
- THEN 每個案例的判定結果 MUST 與本規則生效前相同
