# harness-model-stream-payload Specification

## Purpose
定義 model.stream 回答正文身分欄位的驗證、輸出種類單一來源、kernel 欄位保留，以及 harness 套件的精確版本與核准發布契約。
## Requirements
### Requirement: model.stream 回答正文身分欄位的契約驗證

harness 契約層的 `model.stream` payload MUST 接受三個選用的回答正文身分欄位：訊息身分、輸出種類與文字偏移。三個欄位 MUST 各自選用；凡出現的欄位 MUST 通過自身驗證。訊息身分 MUST 為去除前後空白後非空、且不超過既有不透明識別碼長度上限的字串；輸出種類 MUST 為契約層單一來源定義的封閉列舉值，本次只有回答正文；文字偏移 MUST 為非負安全整數，語意為本訊息先前已發布文字的 UTF-16 code unit 數。既有 `delta` 的型別與長度限制 MUST 不變。payload MUST 維持拒收未宣告欄位。

訊息身分 MUST 依既有不透明識別碼規則去除前後空白，驗證結果中的訊息身分為去除前後空白後的值；這是契約層唯一的正規化。除此之外，凡通過驗證的欄位值 MUST 原樣保留，MUST NOT 改寫、補預設值或做型別轉換。

#### Scenario: 只有 delta 的既有 payload

- GIVEN 一個只有合法 `delta` 的 `model.stream` payload
- WHEN 以契約層 schema 驗證
- THEN MUST 通過
- AND 驗證結果 MUST NOT 新增任何欄位

#### Scenario: 帶完整正文身分欄位

- GIVEN 一個帶合法 `delta`、訊息身分、輸出種類為回答正文、文字偏移為 0 的 payload
- WHEN 以契約層 schema 驗證
- THEN MUST 通過
- AND 三個欄位的值 MUST 原樣保留

#### Scenario: 訊息身分含前後空白

- GIVEN 一個帶合法 `delta` 的 payload，其訊息身分在前後帶有空白，且去除前後空白後非空、不超過長度上限
- WHEN 以契約層 schema 驗證
- THEN MUST 通過
- AND 驗證結果的訊息身分 MUST 為去除前後空白後的值
- AND 其餘欄位的值 MUST 原樣保留

#### Scenario: 文字偏移邊界值

- GIVEN 一個帶合法 `delta` 的 payload，其文字偏移為 0 或最大安全整數
- WHEN 以契約層 schema 驗證
- THEN MUST 通過
- AND 文字偏移的值 MUST 原樣保留

#### Scenario: 只帶部分身分欄位

- GIVEN 一個帶合法 `delta` 與合法訊息身分，但沒有輸出種類與文字偏移的 payload
- WHEN 以契約層 schema 驗證
- THEN MUST 通過
- AND 是否作為回答正文由消費端依自身規則判斷，契約層 MUST NOT 推定

#### Scenario: 未宣告欄位仍被拒

- GIVEN 一個帶合法 `delta` 與任一未宣告欄位的 payload
- WHEN 以契約層 schema 驗證
- THEN MUST 失敗
- AND 失敗原因 MUST 可辨識為未宣告欄位

#### Scenario: 身分欄位值不合法

- GIVEN 一個帶合法 `delta` 的 payload，且下列任一成立：訊息身分為空字串或只有空白；訊息身分超過長度上限；輸出種類不在封閉列舉內；文字偏移為負數、非整數、非有限數或超出安全整數；任一欄位型別錯誤
- WHEN 以契約層 schema 驗證
- THEN MUST 失敗
- AND MUST NOT 以預設值或型別轉換修正輸入

#### Scenario: delta 限制不變

- GIVEN 一個 `delta` 超過既有長度上限、但身分欄位皆合法的 payload
- WHEN 以契約層 schema 驗證
- THEN MUST 失敗

### Requirement: 輸出種類的單一來源

輸出種類的封閉列舉 MUST 由契約套件以公開常數與對應型別匯出，作為唯一來源；payload schema MUST 由該常數推導，MUST NOT 另寫一份字面值清單。新增的公開匯出 MUST 依 public API 政策登錄並標註起始版本。

#### Scenario: schema 與常數一致

- GIVEN 契約套件匯出的輸出種類常數
- WHEN 以常數中的每個值作為輸出種類驗證 payload
- THEN 皆 MUST 通過
- AND 常數以外的值 MUST 失敗

#### Scenario: 公開匯出受治理

- GIVEN 新增的輸出種類常數與型別
- WHEN 執行 API surface 檢查
- THEN 兩者 MUST 已登錄於公開 API 清單
- AND 未登錄的匯出 MUST 使檢查失敗

### Requirement: kernel 解析入口保留身分欄位

kernel 的公開 runtime event 解析入口 MUST 完整保留 `model.stream` payload 的三個身分欄位，MUST NOT 剝除、改名或改寫其值（契約層 schema 對訊息身分的前後空白正規化除外，kernel MUST NOT 另加任何正規化）；遇到不合法欄位時 MUST 以既有錯誤路徑失敗。

#### Scenario: payload 解析保留欄位

- GIVEN 一個帶完整身分欄位的合法 `model.stream` payload
- WHEN 以 kernel 的公開 payload 解析入口依事件類型解析
- THEN 結果 MUST 包含三個欄位且值與輸入相同

#### Scenario: envelope 解析後再解析 payload

- GIVEN 一個合法 envelope，其 payload 為帶完整身分欄位的 `model.stream` payload
- WHEN 先以 kernel 公開入口解析 envelope，再以其事件類型解析 payload
- THEN 兩步結果 MUST 保留三個欄位且值不變

#### Scenario: kernel 拒收不合法欄位

- GIVEN 一個文字偏移為負數的 `model.stream` payload
- WHEN 以 kernel 公開 payload 解析入口解析
- THEN MUST 拋出既有的驗證錯誤
- AND MUST NOT 回傳部分結果

### Requirement: 一批精確版本與核准發布

本次擴充 MUST 以同一批精確 alpha 版本發布所有 harness 套件，套件間相依 MUST 為精確版本且指向同一批版本。發布 MUST 由 Human 核准並執行；本地連結、pack 或 publish dry-run MUST NOT 視為已發布證據。

#### Scenario: 相依樹只有一份契約套件

- GIVEN 新一批版本的套件 tarball
- WHEN 在乾淨環境安裝 testkit
- THEN 相依樹中契約套件 MUST 只有新一批版本的一份

#### Scenario: 未經核准不得發布

- GIVEN 實作與驗證已完成
- WHEN Agent 準備發布
- THEN Agent MUST 停在發布前並交回 Human
- AND MUST NOT 執行 publish

