## ADDED Requirements

### Requirement: 憑證欄位的 bare null 值不視為 Secret

Secret 掃描的 `credential_assignment` 類別 MUST 把「憑證欄位名稱與冒號或等號之後，值是未加引號的 null 字面值（與欄位名稱一樣不分大小寫），且 null 之後緊接行尾、空白、引號、逗號、分號或右大括號」判為不含憑證。這個排除只看值本身；欄位名稱的比對方式（包括以憑證詞結尾的複合名稱）MUST 維持不變。值帶有任何實際字面內容時，MUST 繼續判為 Secret。其他 Secret 類別（provider key、cloud access key、private key、bearer token、JWT）的判定 MUST NOT 受此規則影響。

掃描是同步、無 I/O 的純判定，沒有逾時、取消或重試語意；命中後的抑制與 evidence gate 行為沿用既有規則。

#### Scenario: 複合欄位名稱指派 bare null

- GIVEN 一行輸出含有以授權詞結尾的複合欄位名稱
- AND 該欄位以冒號指派未加引號的 null，其後緊接逗號
- WHEN 執行 Secret 掃描
- THEN 該行 MUST NOT 判為 `credential_assignment`
- AND 該行 MUST NOT 判為任何 Secret 類別

#### Scenario: 以等號指派 bare null

- GIVEN 一行程式碼以等號把未加引號的 null 指派給密碼欄位，其後緊接分號
- WHEN 執行 Secret 掃描
- THEN 該行 MUST NOT 判為任何 Secret 類別

#### Scenario: 大寫的 bare null

- GIVEN 密碼欄位以冒號指派全大寫、未加引號的 null，其後緊接逗號
- WHEN 執行 Secret 掃描
- THEN 該行 MUST NOT 判為任何 Secret 類別

#### Scenario: 加引號的 null 仍是字面值

- GIVEN 密碼欄位的值是以雙引號包住的 null 四個字元
- WHEN 執行 Secret 掃描
- THEN 該行 MUST 判為 `credential_assignment`

#### Scenario: 以 null 開頭並緊接其他字元的值

- GIVEN 密碼欄位的值以 null 開頭，其後直接接上其他英數字元
- WHEN 執行 Secret 掃描
- THEN 該行 MUST 判為 `credential_assignment`

#### Scenario: null 後接連字號的值

- GIVEN 密碼欄位的值以 null 開頭，其後接連字號與其他字元
- WHEN 執行 Secret 掃描
- THEN 該行 MUST 判為 `credential_assignment`

#### Scenario: 複合欄位名稱中的真實憑證

- GIVEN 一行輸出含有以密碼詞結尾的複合欄位名稱
- AND 該欄位以冒號指派一段未加引號的實際字面值
- WHEN 執行 Secret 掃描
- THEN 該行 MUST 判為 `credential_assignment`

#### Scenario: 同一行的 bare null 不遮蔽其他憑證

- GIVEN 同一行先有一個值為 bare null 的憑證欄位
- AND 之後另有一個憑證欄位指派實際字面值
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
- WHEN 執行既有的 Secret 掃描回歸案例（變數插值樣板、測試假值、實際字面值、各 Secret 類別）
- THEN 每個案例的判定結果 MUST 與本規則生效前相同
