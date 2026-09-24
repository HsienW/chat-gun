# Proposal：harden-provider-and-tool-call-decoding

## 變更摘要

把 provider 回應 envelope 與 Tool argument 的解析，從「JSON.parse 失敗就吞掉、malformed Tool argument 靜默塌成 `{}`」的現況，收斂為**有界、型別化、可診斷的 decode 結果**：對 provider 回應 envelope 先做 runtime validation 才讀取 `choices`／`message`／`content`／`tool_calls`／`usage`／`finish_reason`；對 Tool argument 引入 `JsonDecodeResult<T>`（`valid`／`incomplete`／`invalid`／`too_large`），保留 `rawHash`／`byteLength`／`errorCode`／request correlation 等結構化診斷，讓「provider 真的回傳合法空物件」與「JSON 被截斷／格式錯誤／超限」可被明確區分；並在串流啟用時備妥有界 incremental assembler。所有診斷只保留 redacted／hash 形式，不落 raw 敏感內容，修復最多一次且修復候選必須同時通過 strict JSON decode 與 Tool input schema。

本 Change 對應 `second-stage-plan-en-v4.md` 的 **X15**，是 Layer 5（Tool Execution Hardening）的第二個 Change；前置 X12（`add-canonical-execution-context`）與 X14（`establish-unified-tool-dispatch-pipeline`）均已 archive。X14 已建立統一 dispatch pipeline（`descriptor.inputSchema.safeParse(input)` 於 `runtime/tool-dispatch/pipeline.ts:346`），但 **decode 邊界在 llm-gateway 尚未型別化**，malformed Tool argument 在進入 pipeline 之前就被壓成 `{}`，使下游無法分辨「空物件是 provider 的真實回傳」還是「解析失敗的殘骸」。

## 問題描述

盤點確認的關鍵事實（本 Change 建立時）：

1. **`parseToolCallArgs` 靜默塌成 `{}`**：`backend/src/platform/llm-gateway.ts:784-802` 在下列四種情況一律回傳 `{}`：(a) `rawArgs` falsy（`null`／`undefined`／空字串）；(b) `rawArgs` 非 string 且非 plain object（如 array／number）；(c) `JSON.parse` 拋錯；(d) 解析結果非 plain object。因此「截斷的 JSON 片段」與「provider 真的回傳合法空物件」在型別上完全無法區分，違反 X15 Acceptance「Malformed Tool arguments never become `{}` unless the provider actually returned a valid empty object」。

2. **`parseOpenAiToolCalls` 靜默丟棄整筆 tool call**：`backend/src/platform/llm-gateway.ts:804-825` 在輸入非 array、entry 非 object、或 `function.name` 缺失時直接 `flatMap` 濾掉（回傳 `[]`），不產生任何診斷；malformed 的 `function.arguments` 也不會被標記，只會經 `parseToolCallArgs` 塌成 `{}`。

3. **`parseJsonResponse<T>` 只有單一 parse error，無分類**：`backend/src/platform/llm-gateway.ts:369-390` 只在 `JSON.parse` 拋錯時丟出單一 `ProviderResponseParseError`（附 `responseContentLength`），不區分 `incomplete`／`invalid`／`too_large`，也無 `rawHash`、request correlation、finish reason 或 content-filter refusal 的結構化欄位。

4. **provider 回應 envelope 未做 runtime validation**：`OpenAiChatCompletionResponse`（`llm-gateway.ts:292-307`）與 `AnthropicMessagesResponse`（`llm-gateway.ts:319-324`）的欄位都以 `unknown` 寬鬆型別宣告；`OpenAiCompatibleChatModel.invoke` 直接以 optional chaining 讀取 `parsed.choices?.[0]`、`choice?.message`、`message?.tool_calls`（`llm-gateway.ts:1029-1045`），未驗證 envelope 形狀。一個「JSON 合法但 envelope 形狀錯誤」的回應（例如 `choices` 是 string、`message.content` 是 object）會靜默降級成空的 `AIMessage`，丟失錯誤語意。

5. **structured-output repair 的 `parseCandidate` 只區分 parse 成敗，不區分 incomplete／invalid／too_large**：`backend/src/platform/structured-output-repair.ts:71-97` 在 `JSON.parse` 失敗時回 `{ ok: false, error: "JSON parse failed" }`，無 byte length／rawHash／錯誤子分類；這是 content JSON 的修復路徑，與 Tool argument decode 契約彼此孤立。

6. **fallback 錯誤分類只有單一 `provider_response_invalid` bucket**：`backend/src/platform/provider-error-category.ts:46-48` 把 `ProviderResponseParseError` 與 `SyntaxError` 都歸到 `provider_response_invalid`；`isFallbackEligibleCategory`（`provider-error-category.ts:66-72`）已依 stable category（非 error-message substring）決定 fallback 資格（這是正確方向），但 decode 的 incomplete／invalid／too_large 子類未被保留供 root-cause analysis 與 fallback 策略區分。

7. **provider streaming 尚未啟用，也無 bounded incremental assembler**：`capabilitiesForProvider` 對所有 provider 都回 `supportsStreaming: false`（`llm-gateway.ts:405,414`），`ChatModelInvoker` 只有 `invoke`／`bindTools`，無 stream 方法；不存在任何有界組裝器來承接「JSON split between UTF-8 chunks」「unterminated escape」「depth/payload 超限」等串流邊界情境。

綜合而言，Provider Adapter 已具備「fallback 分類」「structured-output repair」等原語，但 **Tool argument decode 的邊界仍是 silent degradation**，正違反根目錄 `AGENTS.md` §6（不得以硬編碼／靜默降級取代可擴充契約）與 X11 Cross-Layer Invariant #8（「Stable machine identifiers drive behavior」——decode 結果必須是 stable machine 可讀，不得靠顯示文字反推）。

## 解決方案

以「單一 typed decode primitive + 單一 envelope runtime schema + 單一 bounded assembler + 單一 repair 入口」收斂：

1. **建立 typed JSON decode primitive**：新增 `platform/json-decode.ts`，提供 `JsonDecodeResult<T>`（`valid`／`aborted`／`incomplete`／`invalid`／`too_large`）與 `decodeJsonText(text, { maxBytes, maxDepth, signal })`，分類 JSON 錯誤為 `incomplete`（未閉合 brace/bracket、未終止字串、被 UTF-8 切斷）／`invalid`（syntax error）／`too_large`（byte 或 depth 超限）／`aborted`（取消），並回傳 `byteLength` 與 `rawHash`（sha256，供比對與去識別化，不落 raw；`too_large` 因避免對超限 payload hash 而不保留 `rawHash`）。

2. **provider envelope 先 runtime-validate 再讀取**：為 openai-chat-completions 與 anthropic-messages 各建立 strict envelope schema（Zod），在 `parseJsonResponse` 之後、讀取 `choices`／`message`／`content`／`tool_calls`／`usage`／`finish_reason` 之前驗證形狀；未知額外欄位與未來 provider 欄位採 passthrough／忽略（不得因 forward-compatible 欄位而整包拒絕），但必備欄位形狀錯誤必須 fail-closed 並回 stable error code。

3. **以 typed decode result 取代靜默 `{}`**：改寫 `parseToolCallArgs`／`parseOpenAiToolCalls`，使 decode 結果可區分 `valid`／`incomplete`／`invalid`／`too_large`；只有 provider 真的回傳合法空物件時才得空物件；malformed 不得 dispatch，decode 診斷（`errorCode`／`byteLength`／`rawHash`）隨 structured result ／ audit ／ tracing 保留下來。

4. **備妥有界 incremental assembler（不啟用 streaming）**：新增 standalone、經單元測試的 bounded assembler（maximum bytes、maximum nesting depth、deadline 與 `AbortSignal`、explicit end-of-stream、UTF-8 與 escape-sequence boundary 處理），滿足 Required Cases 的串流切斷／逾時／取消情境；本 Change 不接線 provider streaming（streaming 啟用與 versioned event envelope 屬 X19 及後續 Change）。

5. **最多一次 configured repair**：當證據顯示 truncation 或 schema-repair eligible 時，最多一次 repair；repair 候選 MUST 通過 strict JSON decode 且通過 Tool input schema，否則維持 exhaust；exhaustion 產生 stable terminal/error result。

6. **content-filter refusal 與 parse/validation 失敗分開**：沿用既有 `content_filter_refusal` category（`provider-error-category.ts`），確保 Tool argument decode 的 refusal 不被誤判為 parse error，也不進入 retry。

7. **fallback 資格依 stable error category**：新增 stable category `provider_decode_failure`（非 fallback-eligible、不進 invoke retry），並保留 decode 子類（`incomplete`／`invalid`／`too_large`）供分類與 root-cause；fallback 資格仍只由 stable category 判定，MUST NOT 以 error-message substring 決定。

8. **不落 raw 敏感內容**：一般 log 與 hosted telemetry 只保留 `rawHash`／`byteLength`／redacted 診斷與 errorCode；MUST NOT 落 raw Tool argument、raw provider body 或未遮罩 PII。

## 受影響範圍

### 受影響套件

- `backend`：`platform/json-decode.ts`（新）、`platform/llm-gateway.ts`（envelope schema + typed tool-arg decode）、`platform/provider-error-category.ts`（decode 子類）、`platform/structured-output-repair.ts`（可選共用 primitive，不變更其既有 status 語意）、`platform/stream-assembler.ts`（新，standalone）、對應 `*.test.ts` 與 fuzz/property test。

### 受影響能力域

- Model Provider Adapter（envelope parsing、tool-call decoding、fallback 分類）。
- Tool dispatch 邊界（decode 結果 → X14 pipeline 的 `inputSchema` 前，malformed 不得 dispatch）。
- 可觀測性與 redaction（rawHash／byteLength／errorCode，不落 raw）。

### 既有能力原語（本 Change 接線、不重造）

- `provider-error-category.ts`（`classifyProviderError`／`isFallbackEligibleCategory`，stable category）。
- `structured-output-repair.ts`（`repairStructuredOutput`／`RepairResult`，content JSON 修復）。
- `runtime/tool-dispatch/pipeline.ts`（X14：`inputSchema.safeParse` 與 structured result）。
- `platform/errors.ts`（`createErrorEnvelope`／`formatErrorEnvelope`，error envelope）。
- `platform/observability.ts`（`recordMetric`）與 `platform/tracing/`（span）。
- X12 `canonical-execution-context`（request correlation 之 `runId`／`taskId`／`stepId`／`toolCallId`）。

## 目標

- Malformed Tool argument MUST NOT 變成 `{}`，除非 provider 真的回傳合法空物件。
- `incomplete`／`invalid`／`too_large`／`refusal`／schema-invalid 五種 outcome MUST 可被區分。
- 一次有界 repair MAY 修復 eligible case；exhaustion MUST 產生 stable terminal/error result。
- Cancellation MUST 停止 assembly 與 repair，且不再觸發後續 model 或 Tool call。
- Fuzz／property test MUST NOT crash、hang、無界分配或 dispatch invalid input。
- 既有 valid Tool-call fixtures 跨 configured providers MUST 保持相容（Weather／Web／Calculator／MCP）。

## 非目標

- ❌ 不啟用 provider streaming（streaming 啟用與 versioned stream event envelope 屬 X19／後續 Change）。
- ❌ 不做任意 malformed JSON 的盲目補 brace／補括號。
- ❌ 不引入接受註解、可執行表達式或非 JSON 語法的 permissive parser。
- ❌ 不變更既有 Graph ID、公開 BFF route、Tool 名稱或既有 error-code 語意。
- ❌ 不新增 frontend／bff 變更（decode 屬 backend 邊界；前端承接的是 X14 structured result 的既有 envelope，不需新增欄位）。
- ❌ 不改寫 X14 統一 dispatch pipeline 的 authorization／ledger／reconcile 順序（本 Change 只在 pipeline 上游補 decode 邊界）。
- ❌ 不把 structured-output repair 的既有 `RepairStatus` 語意推翻（僅視需要抽共用 primitive，不改其成功／partial／refusal／exhausted 語意）。

## 風險

| 風險 | 緩解 |
|---|---|
| typed decode 邊界接線後，既有 valid Tool-call 回歸被誤判為 invalid | 以既有 fixture（`llm-gateway.test.ts`、`mcp-agent.tool-calling.test.ts`、`qwen-runtime.live-smoke.test.ts`）做 golden 回歸；envelope schema 對未知欄位 passthrough |
| `too_large` 或 depth 上限設定過嚴，誤拒合法大 payload | 上限採 configuration 單一來源（runtime-config），有預設值與 explicit override；fuzz 證明無界分配不發生 |
| `rawHash` 洩漏可 reverse 的短 content | 只在診斷路徑保留 hash；一般 log／telemetry 不落 raw；redaction 由既有 `opik-redaction` 原則覆蓋 |
| repair 把 malformed 誤修成「看似合法」的 input 而 dispatch | repair 候選 MUST 同時通過 strict JSON decode 與 Tool input schema；無任一通過則 exhaust，不 dispatch |
| decode 子類（incomplete／invalid／too_large）誤入 retry | 依 stable error category 判定；decode failure 預設不 retry（除非 explicit repair 且 eligible） |
| 串流 assembler 邊界（UTF-8 切斷／escape）處理不完整 | 以 property test 覆蓋多碼點、跨 chunk、未終止 escape、EOS 前切斷；assembler 為 standalone，未接 production 前不影響既有路徑 |

## 回滾策略

本 Change 為 backend 邊界的 additive 變更：新增 `json-decode.ts`／`stream-assembler.ts` 模組與 envelope schema；`parseToolCallArgs`／`parseOpenAiToolCalls` 改為回傳 typed result，但不變更成功路徑產出的 `ToolCall` 形狀（既有 valid fixture 行為不變）。若驗證失敗，可逐模組 revert 回既有 `JSON.parse` 行為；envelope schema 採「驗證後 fail-closed 但未知欄位 passthrough」的 additive 設計，不變更 provider wire format，亦不影響 frontend／bff。無資料庫 migration 或 Graph ID／route 變更。
