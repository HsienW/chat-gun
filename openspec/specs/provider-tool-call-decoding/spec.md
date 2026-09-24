# provider-tool-call-decoding Specification

## Purpose

本規格定義 provider 回應 envelope 與 Tool argument 的有界、型別化 decode 需求：provider 回應 envelope 必須先 runtime-validate 才讀取內容；Tool argument 解析必須以 `JsonDecodeResult<T>`（`valid`／`incomplete`／`invalid`／`too_large`）區分 outcome，不得靜默塌成空物件；串流組裝必須有界；修復最多一次且修復候選必須通過 strict JSON decode 與 Tool input schema；fallback 資格依 stable error category，不依 error-message substring。

## Requirements

### Requirement: provider 回應 envelope MUST 於讀取前通過 runtime validation

provider 回應 body 在讀取 `choices`／`message`／`content`／`tool_calls`／`usage`／`finish_reason` 之前 MUST 先通過 endpoint kind 對應的 strict runtime schema；未知額外欄位與未來 provider 欄位 MAY passthrough，但必備欄位形狀錯誤 MUST fail-closed 並回 stable error code。

#### Scenario: 合法 envelope 正常讀取

GIVEN 一個形狀合法的 provider 回應 envelope
WHEN 執行 envelope validation
THEN MUST 通過
AND MUST 可讀取 `choices`／`message`／`content`／`tool_calls`／`usage`／`finish_reason`

#### Scenario: 必備欄位形狀錯誤 fail-closed

GIVEN 一個 JSON 合法但必備欄位形狀錯誤的回應（例如 `choices` 為 string、`message` 非 object）
WHEN 執行 envelope validation
THEN MUST 回 stable error code（`PROVIDER_ENVELOPE_INVALID`）
AND MUST NOT 讀取其餘欄位或 dispatch Tool

#### Scenario: 未知額外欄位不整包拒絕

GIVEN 一個含未知額外欄位的合法回應
WHEN 執行 envelope validation
THEN MUST 通過（passthrough）
AND MUST NOT 因 forward-compatible 欄位整包拒絕

---

### Requirement: malformed Tool argument MUST NOT 靜默變成空物件

Tool argument 解析 MUST 以 `JsonDecodeResult<T>` 區分 `valid`／`incomplete`／`invalid`／`too_large`；只有 provider 真的回傳合法空物件時，Tool argument 才得空物件。

#### Scenario: 截斷 JSON 不變成空物件

GIVEN 一個未閉合 brace 或未終止 string 的 Tool argument
WHEN 執行 Tool argument decode
THEN MUST 回 `incomplete`
AND MUST NOT 回傳空物件 `{}`
AND MUST NOT dispatch 該 Tool

#### Scenario: 合法空物件仍可通過

GIVEN provider 回傳字串 `"{}"`（合法空物件）
WHEN 執行 Tool argument decode
THEN MUST 回 `valid` 且 value 為空物件
AND MUST 依 Tool input schema 決定是否可 dispatch

#### Scenario: 型別不符回 invalid

GIVEN Tool argument 為 array／scalar／number，但 Tool input schema 要求 object
WHEN 執行 Tool argument decode
THEN MUST 回 `invalid` 或依 schema 判定 schema-invalid
AND MUST NOT 以空物件填充後 dispatch

---

### Requirement: decode outcome 的 aborted／incomplete／invalid／too_large／refusal／schema-invalid MUST 可區分

decode 後的 outcome 必須可機器分辨 `aborted`（取消）、`incomplete`（截斷）、`invalid`（syntax error）、`too_large`（byte／depth 超限）、`refusal`（content-filter）、schema-invalid（通過 JSON 但未過 input schema）。`incomplete` 與 `invalid` MUST 保留 `byteLength` 與 `rawHash` 診斷；`too_large` MUST 保留 `byteLength` 與 `errorCode` 而 MUST NOT 保留 `rawHash`（對超限 payload 計算 hash 屬不必要的 CPU amplification，`byteLength`＋`errorCode`＋`maxBytes` 已足以診斷）；`aborted` 不攜帶內容。診斷不得落在 raw 敏感內容。

#### Scenario: 各 outcome 具穩定分類

GIVEN 一組取消／截斷／語法錯誤／超限／refusal／schema-invalid 的輸入
WHEN 執行 decode
THEN 每個 outcome MUST 對應唯一 stable 分類
AND `incomplete`／`invalid` MUST 保留 `byteLength` 與 `rawHash`（不回傳 raw）
AND `too_large` MUST 保留 `byteLength` 且 MUST NOT 回傳 `rawHash`

#### Scenario: 取消回 aborted 且不 parse

GIVEN decode 前 `AbortSignal` 已觸發
WHEN 執行 decode
THEN MUST 回 `aborted`
AND MUST NOT parse、不分配
AND MUST NOT 進入 repair／retry／fallback

#### Scenario: content-filter refusal 不誤判為 parse 失敗

GIVEN provider 回傳 content-filter refusal
WHEN 執行 decode 分類
THEN MUST 分類為 refusal
AND MUST NOT 分類為 `invalid` 或進入 retry

---

### Requirement: 串流組裝 MUST 有界且具明確 end-of-stream 語意

provider streaming 的 incremental assembler MUST 有 maximum bytes、maximum nesting depth、deadline 與 `AbortSignal`、explicit end-of-stream 語意，並正確處理 UTF-8 與 escape-sequence boundary；超限或取消 MUST 停止累積且不無界增長。

#### Scenario: 超限停止累積

GIVEN 一個超過 `maxBytes` 或 `maxDepth` 的串流輸入
WHEN 執行 assembler
THEN MUST 回 `too_large`
AND MUST NOT 繼續無界累積

#### Scenario: UTF-8 跨 chunk 不誤判

GIVEN JSON 被切在 UTF-8 多碼點中間
WHEN 執行 assembler
THEN MUST 於收齊位元組後正確還原
AND MUST NOT 誤判為 `invalid`

#### Scenario: end-of-stream 前切斷回 incomplete

GIVEN 串流在未閉合結構或未終止 string 前 end-of-stream
WHEN 執行 `end()`
THEN MUST 回 `incomplete`
AND MUST NOT 產生合法 value

#### Scenario: 取消停止組裝

GIVEN assembler 已累積部分內容
WHEN `AbortSignal` 觸發
THEN MUST 停止組裝
AND MUST NOT 觸發後續 model 或 Tool call

---

### Requirement: repair MUST 最多一次且修復候選必須通過 strict decode 與 Tool input schema

當證據顯示 truncation 或 schema-repair eligible 時，MUST 最多執行一次 configured repair；修復候選 MUST 通過 strict JSON decode 且通過 Tool input schema 才得採用；exhaustion MUST 產生 stable terminal/error result。

#### Scenario: 一次修復成功

GIVEN 一個 eligible 的截斷或 schema-repair 候選
WHEN 執行 repair
THEN 修復候選 MUST 通過 strict JSON decode 與 Tool input schema
AND MUST 最多修復一次

#### Scenario: 修復失敗後 exhaust

GIVEN 修復候選無法通過 strict decode 或 input schema
WHEN 執行 repair
THEN MUST exhaust
AND MUST 產生 stable terminal/error result
AND MUST NOT dispatch 該 Tool

#### Scenario: refusal 不進入 repair

GIVEN 一個 content-filter refusal
WHEN 執行 repair 決策
THEN MUST NOT 進入 repair
AND MUST 維持 refusal 分類

---

### Requirement: fallback 與 invoke retry MUST 依 stable error category 排除 decode failure

provider fallback 資格 MUST 由 stable error category（含 `provider_decode_failure`）判定；MUST NOT 以 error-message substring 或自然語言文字決定 fallback。decode failure（tool argument `incomplete`／`invalid`／`too_large`）MUST 由 stable category `provider_decode_failure` 標記，該 category MUST NOT 為 fallback-eligible 亦 MUST NOT 進入 invoke retry loop；repair 是唯一 re-attempt 路徑（最多一次）。

#### Scenario: 依 stable category 判定 fallback

GIVEN 一個帶結構化 error category 的 provider 錯誤
WHEN 執行 fallback 資格判定
THEN MUST 依 stable category 決定
AND MUST NOT 解析 error-message substring

#### Scenario: decode failure 不 fallback 亦不 invoke-retry

GIVEN 一個 tool argument decode 失敗（`incomplete`／`invalid`／`too_large`）
WHEN 執行 fallback 與 invoke retry 決策
THEN MUST 分類為 `provider_decode_failure`
AND MUST NOT fallback 至下一 provider
AND MUST NOT 進入 invoke retry loop
AND 只有 explicit repair（最多一次）且 eligible 才得嘗試

#### Scenario: envelope 形狀錯誤仍可依 provider contract 處理

GIVEN 一個 envelope 形狀錯誤（`PROVIDER_ENVELOPE_INVALID`，於 dispatch 前發生、無 side-effect 風險）
WHEN 執行 fallback 資格判定
THEN MAY 分類為 `provider_response_invalid` 並 fallback
AND MUST NOT 以 decode failure 的語意處理

---

### Requirement: 既有 valid Tool-call fixtures MUST 保持相容

decode 邊界接線後，既有 Weather／Web／Calculator／MCP 的 valid Tool-call fixtures MUST 保持行為相容；MUST NOT 變更既有 Graph ID、公開 BFF route、Tool 名稱或 error-code 語意。

#### Scenario: 既有成功路徑行為不變

GIVEN 一組既有 valid Tool-call fixtures
WHEN 執行 decode
THEN MUST 產出與既有相同的 `ToolCall`（`id`／`name`／`args`／`type`）
AND MUST 通過既有 golden eval／mock smoke／live smoke 回歸

#### Scenario: 契約語意不變

GIVEN 本 Change 已接線
WHEN 檢查跨層契約
THEN MUST NOT 變更既有 Graph ID／公開 BFF route／Tool 名稱／error-code 語意
