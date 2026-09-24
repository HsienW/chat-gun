# Design：harden-provider-and-tool-call-decoding

## 責任邊界

本 Change 只落在 **backend** 的 Provider Adapter 與 Tool dispatch 上游邊界；**不變更 frontend、bff**。frontend 承接的仍是 X14 既有的 versioned structured tool result envelope，本 Change 不新增任何跨層欄位或 route。decode 產出的結構化診斷（`errorCode`／`byteLength`／`rawHash`）經 audit／tracing 落 backend 可觀測層，不新增 frontend 契約。

## 資料流

### Before（現況，靜默降級）

```text
provider body (text)
  → parseJsonResponse<T>()            // 只 JSON.parse，單一 ProviderResponseParseError
  → 讀 parsed.choices?.[0].message      // 未驗證 envelope 形狀
  → parseOpenAiToolCalls(message.tool_calls)
      → parseToolCallArgs(arguments)    // JSON.parse 失敗 → {}（靜默）
  → AIMessage.tool_calls                // malformed 已被壓成 {} 或整筆丟棄
  → LangGraph ToolNode → X14 pipeline.descriptor.inputSchema.safeParse({})
```

### After（型別化 decode）

```text
provider body (text)
  → parseJsonResponse<T>()  →  只做「byte → JSON」的 syntactic parse
  → validateProviderEnvelope(parsed, endpointKind)   // strict runtime schema；未知欄位 passthrough
  → decodeToolCalls(validatedEnvelope)
      → decodeToolArgumentText(arguments)  // JsonDecodeResult<T>
          → valid              → 回 ToolCall.args
          → aborted            → 立即中止（不 parse、不 repair、不 retry、不 fallback）
          → incomplete/invalid → 最多一次 repair；修復候選通過 strict decode + input schema 才採用，否則 terminal error
          → too_large          → terminal error（不 repair）
  → AIMessage.tool_calls（valid 才存在；malformed 不回 {}，而帶 diagnostics）
  → LangGraph ToolNode → X14 pipeline（invalid/incomplete 已於上游攔截，不進 inputSchema）
```

## 模組設計

### `platform/json-decode.ts`（新）

單一 typed decode primitive，供 envelope、Tool argument 與（可選）structured-output repair 共用。型別與 X15 issue 的 `JsonDecodeResult<T>` 一致，另加 `aborted`（見下文）：

```typescript
export type JsonDecodeResult<T> =
  | { status: "valid"; value: T }
  | { status: "aborted" }
  | { status: "incomplete"; errorCode: string; rawHash: string; byteLength: number }
  | { status: "invalid"; errorCode: string; rawHash: string; byteLength: number }
  | { status: "too_large"; errorCode: string; byteLength: number };

export interface JsonDecodeOptions {
  maxBytes: number;
  maxDepth: number;
  signal?: AbortSignal;
}

export function decodeJsonText(text: string, options: JsonDecodeOptions): JsonDecodeResult<unknown>;
```

- `decodeJsonText` 依序檢查：
  1. `signal?.aborted` → `{ status: "aborted" }`（不 parse、不分配、不 hash）。
  2. `byteLength > maxBytes` → `{ status: "too_large", errorCode, byteLength }`。
  3. depth 超限 → `{ status: "too_large", errorCode, byteLength }`。
  4. 未閉合 `{`／`[`、未終止 string、字尾截斷 escape → `incomplete`。
  5. 其餘 syntax error → `invalid`。
  6. 成功 → `valid`。
- **`aborted` 獨立 variant**：abort 語意與四種 decode outcome 本質不同，不得映射為 `invalid` 或獨立 throw；assembler 與 `decodeJsonText` 共用同一 variant。
- **`too_large` 不保留 `rawHash`**：對超限（可能為 attacker-controlled、數十 MB 以上）的 payload 計算 SHA-256 屬不必要的 CPU amplification，且該 outcome 只要 `byteLength`＋`errorCode`＋`maxBytes` 即足以診斷；故 `too_large` 只保留 `byteLength`。其餘 `incomplete`／`invalid` 保留 `rawHash = sha256(text)`（不回傳 raw）。
- depth 檢查採**迭代式前置掃描（iterative bracket-depth scan）**：stack-safe、O(n)，明確**排除遞迴 parser**（避免超深輸入造成 Node.js stack overflow）；掃描達 `maxDepth` 即回 `too_large`，不進入 `JSON.parse`。
- 分類規則只依「JSON 語法結構」，不依 natural language 或顯示文字。

### `platform/provider-envelope.ts`（新）

兩個 endpoint kind 的 strict runtime schema（Zod），供 envelope 形狀驗證：

- `openai-chat-completions`（non-streaming，本 Change 唯一啟用情境）：`{ id?, model?, choices, usage?, ...future }`；**`choices` 為 required array**（non-streaming endpoint 的語意必備欄位），每項 `finish_reason` 與 `message` 形狀受驗證；`message.tool_calls` 為 array 且每項 `function.name`／`function.arguments` 形狀受驗證（`arguments` 在此只驗證是 string，內容 decode 交由 `decodeToolArgumentText`）。
- `anthropic-messages`：`{ content, ...future }`；`content` 為 required array 且 text block 形狀受驗證。
- 兩者皆 `.passthrough()` 未知欄位（forward-compatible），但**必備欄位形狀錯誤 → fail-closed**，回 stable error code（`PROVIDER_ENVELOPE_INVALID`），不讀取其餘欄位。
- 未來啟用 streaming（X19）時另立 streaming envelope schema（`delta` 形狀）；本 Change 不引入 streaming envelope。

### `platform/llm-gateway.ts`（改）

- `parseJsonResponse<T>`：保留 syntactic parse 邊界；parse 失敗改走 `decodeJsonText` 分類，丟出攜帶子類（`incomplete`／`invalid`／`too_large`／`aborted`）的 `ProviderResponseParseError`（擴充欄位，不改 name 語意以維持 `provider-error-category` 相容）。
- 新增 envelope 驗證呼叫：在 `parseJsonResponse` 之後、讀取 `choices`／`content` 前執行 `validateProviderEnvelope`；形狀錯誤回 `PROVIDER_ENVELOPE_INVALID`。
- **Tool argument decode 回傳型別**：`parseOpenAiToolCalls` 改回傳

  ```typescript
  interface ToolCallsDecodeResult {
    toolCalls: ToolCall[];                 // 只含 decode 為 valid 的 entries
    diagnostics: ToolCallDecodeDiagnostic[]; // 被丟棄 entry 的結構化診斷
  }
  interface ToolCallDecodeDiagnostic {
    index: number;
    reason: "missing_name" | "arguments_decode_failed";
    decode?: JsonDecodeResult<unknown>;    // arguments 的 decode 結果（redacted 投影）
  }
  ```

  `AIMessage` 建構只取用 `toolCalls`（valid）；`diagnostics` 以 redacted 形式進入 audit／span。**malformed 不再塌成 `{}` 也不被靜默丟棄**，而是保留為 `diagnostics`。
- 新增 typed error `ToolArgumentDecodeError extends Error`：`code = "provider_decode_failure"`、`decodeKind: "incomplete" | "invalid" | "too_large"`、`byteLength`、`rawHash?`（`too_large` 省略）、request correlation。當 repair 窮盡或 `too_large`／`aborted` 時由 tool-arg decode 路徑丟出。
- 成功路徑產出的 `ToolCall` 形狀不變（`id`／`name`／`args`／`type`），以維持既有 fixture。

### `platform/stream-assembler.ts`（新，standalone）

有界 incremental assembler，供未來 streaming 接線（本 Change 不接線）：

```typescript
export type AssemblerResult = JsonDecodeResult<unknown>;  // 與非串流路徑同一 decode 語意，含 aborted

export interface BoundedAssemblerOptions {
  maxBytes: number;
  maxDepth: number;
  deadlineMs: number;
  signal?: AbortSignal;
}

export class BoundedJsonStreamAssembler {
  push(chunk: string | Uint8Array): AssemblerResult; // 累積、處理 UTF-8 邊界與 escape；未完成時回含 pending 的中間結果或需要更多輸入
  end(): AssemblerResult;                            // explicit end-of-stream；交由 decodeJsonText 分類
  abort(reason?): void;                              // 使後續 push/end 回 { status: "aborted" }
}
```

- 維護 UTF-8 不完全位元組 buffer，避免跨 chunk 切斷多碼點。
- 維護「目前是否在 string 內」與「是否在 escape 中」的簡化狀態，供 `end()` 判定 `incomplete`（unterminated string／escape）。
- 每次 `push` 檢查 `maxBytes`／`maxDepth`／`deadline`／`signal`；超限 → `too_large`、取消 → `aborted`，且停止累積（不再無界增長）。
- `end()` 收尾後交由 `decodeJsonText` 做最終分類，確保與非串流路徑共用同一 decode 語意（含 `aborted`）。

### `platform/provider-error-category.ts`（改）

- 新增 stable category `provider_decode_failure`（與既有 `provider_response_invalid` 區分）。
- `classifyProviderError` 依 error 的 `code`／`name`（非 message substring）分類：`ToolArgumentDecodeError`（`code = "provider_decode_failure"`）→ `provider_decode_failure`；`ProviderResponseParseError`／`SyntaxError` → `provider_response_invalid`（不變）；`StructuredOutputRefusalError` → `content_filter_refusal`（不變）。
- `isFallbackEligibleCategory`：`provider_decode_failure` **回 `false`**（顯式排除）；`provider_response_invalid` 維持 `true`（envelope 形狀錯誤於 dispatch 前發生、無 side-effect 風險，fallback 可恢復）。
- decode 子類（`incomplete`／`invalid`／`too_large`）以結構化欄位 `decodeKind` 保留供 root-cause，不改變上述 category 判定。

### `platform/structured-output-repair.ts`（可選共用，不改語意）

- 視需要抽 `decodeJsonText` 供 `parseCandidate` 使用，使其能回報 `incomplete`／`invalid`／`too_large`／`aborted` 子類；`RepairResult` 的 `status` 語意（`success`／`repaired`／`partial`／`refusal`／`exhausted`）不變。

## Fallback 與 invoke retry 對 decode failure 的排除（Major #1 決議）

decode failure（tool argument 截斷／語法錯誤／超限）是**模型輸出品質問題**，不是 provider transport 問題，generic invoke retry 與 fallback 鏈都不會修復它，只會浪費 latency 與 token 配額；因此兩層 MUST 一致排除：

1. **新增 `provider_decode_failure` category**（`provider-error-category.ts`）：stable、非 fallback-eligible。
2. **`isFallbackEligibleCategory("provider_decode_failure")` 回 `false`**：`FallbackChatModelInvoker`（`llm-fallback.ts:174`）依此不 fallback 至下一 provider。
3. **invoke retry loop guard**（`llm-gateway.ts` 993-1050）：catch block 於 retry 前檢查 `classifyProviderError(lastError) === "provider_decode_failure"` 或 `lastError instanceof ToolArgumentDecodeError`，命中即 break（不 retry）。
4. **aborted 立即中止**：`signal.aborted` 於兩層皆最高優先（既已存在），decode 的 `aborted` variant 不進入 retry／repair／fallback。
5. **repair 是唯一 re-attempt 路徑**：tool-arg decode 的 `incomplete`／`invalid` 只在 T5 的 bounded repair 入口重試**最多一次**（非 invoke 的 `maxRetries`），`too_large` 不 repair；repair 窮盡丟 `ToolArgumentDecodeError`。

> envelope 形狀錯誤（`PROVIDER_ENVELOPE_INVALID`）維持 `provider_response_invalid`（fallback-eligible、可 retry）：它發生在讀取 envelope 階段、尚未 dispatch 任何 Tool，無 side-effect 風險，fallback 至其他 provider 可恢復，且屬 provider contract violation 而非模型輸出品質問題。

## Repair 入口（T5）的 evidence 定義

- `incomplete` 自動構成 truncation evidence（截斷的結構性特徵）。
- `invalid` 須搭配 `finish_reason === "length"` 或 provider 回傳的 token-limit 診斷，才構成 truncation evidence；其餘 `invalid` 不 repair（避免違反「不盲目補 brace」）。
- `too_large`／`aborted` 不 repair。
- repair 候選 MUST 通過 strict JSON decode 且通過 Tool input schema，否則 exhaust；exhaustion 丟 `ToolArgumentDecodeError`。

## Tool argument decode → X14 pipeline 整合

- 只有 `valid` 的 `ToolCall.args` 才進入 LangGraph ToolNode 與 X14 pipeline 的 `descriptor.inputSchema.safeParse`。
- malformed entry 不回 `{}` 也不進 `tool_calls`，改以 `ToolCallDecodeDiagnostic` 保留；repair 窮盡或 `too_large`／`aborted` 則不 dispatch 且回 stable error。
- 承 X14：decode 產出的 `errorCode`／`rawHash`／`byteLength` 以 redacted 形式進入 audit 與 span attribute，不落 raw。

## 可觀測性與 redaction

- 一般 log／hosted telemetry 只含：`provider`、`endpointKind`、`finishReason`、request correlation（`runId`／`taskId`／`stepId`／`toolCallId`）、`byteLength`、`rawHash`、`errorCode`。
- MUST NOT 落 raw Tool argument、raw provider body、未遮罩 PII；redaction 沿用既有 `opik-redaction` 原則。

## 相容性

- 既有 valid Tool-call fixtures（Weather／Web／Calculator／MCP）行為不變；`ToolCall` 成功形狀不變。
- envelope schema 對未知欄位 passthrough，不因 forward-compatible 欄位整包拒絕。
- 不變更既有 Graph ID、公開 BFF route、Tool 名稱、error-code 語意。

## 未驗證假設

- 本 Change 不接線 provider streaming，故 assembler 的「真實 provider 串流 chunk 行為」屬未驗證假設；assembler 以 deterministic unit test + property test 證明契約，live streaming 驗證屬後續 Change（X19）的 L 證據。
- depth 限制的「迭代式前置掃描」效能與正確性以 property test 證明，非 live 驗證。

## 替代方案與取捨

| 方案 | 取捨 | 結論 |
|---|---|---|
| 在 X14 pipeline 內做 Tool argument decode（而非 llm-gateway） | pipeline 收到的 `input` 已是 LangGraph 傳入的 `args`，malformed 早已在 gateway 被 LangChain 反序列化層吃掉；decode 邊界應在 provider adapter | 採用 gateway 上游 decode |
| 引入 permissive parser（接受註解／單引號） | 違反 X15 Excludes「No permissive parser」；風險高 | 不採用 |
| 盲目補 brace／括號修復任意 malformed JSON | 違反 X15 Excludes「No blind brace completion」；可能把截斷 payload 誤修成假合法 | 不採用 |
| 以 error-message substring 判斷 fallback 資格 | 違反 X15「stable error category, not error-message substring」 | 不採用；沿用並擴充 stable category |
| 遞迴 parser 做 depth 限制 | 超深輸入可能 stack overflow | 不採用；採迭代式前置掃描 |
| `aborted` 映射為 `invalid` | 語意錯誤，把取消誤判為資料問題 | 不採用；新增 `aborted` variant |
| `too_large` 保留 rawHash | 對超限 payload hash 屬 CPU amplification | 不採用；`too_large` 省略 rawHash，spec 加例外 |
