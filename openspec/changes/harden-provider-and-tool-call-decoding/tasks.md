# Tasks：harden-provider-and-tool-call-decoding

> 每個 Task 可獨立驗證；驗證命令以 backend 現有 script（lint／test／build）為主。未完成的驗證如實標記，不假稱通過。provider streaming 啟用與 live stream 驗證屬後續 Change（X19）的 L 證據，於回報中明確列出未驗證項。

## T1 建立 typed JSON decode primitive（backend）

> 無前置依賴。

- [x] 新增 `platform/json-decode.ts`：`JsonDecodeResult<T>`（`valid`／`aborted`／`incomplete`／`invalid`／`too_large`）與 `decodeJsonText(text, { maxBytes, maxDepth, signal })`。
- [x] 分類規則：`too_large`（byte 或 depth 超限，保留 `byteLength` 不保留 `rawHash`）、`incomplete`（未閉合 brace/bracket、未終止 string、字尾截斷 escape）、`invalid`（其餘 syntax error）、`valid`；`incomplete`／`invalid` 保留 `rawHash = sha256(text)` 不回傳 raw。
- [x] `signal.aborted` 時回 `{ status: "aborted" }`（不 parse、不分配、不 hash）。
- [x] depth 檢查採迭代式前置掃描（iterative bracket-depth scan，stack-safe），超深輸入回 `too_large`，不得 stack overflow；不得採用遞迴 parser。
- [x] 新增 fuzz/property test：隨機截斷、未終止 escape、多碼點、超深 nesting、超大 payload 皆不 crash／hang／無界分配。

驗證命令：

```bash
cd backend
npm run test -- src/platform/json-decode.test.ts
npm run lint
```

## T2 建立 provider envelope runtime schema（backend）

> 無前置依賴。

- [x] 新增 `platform/provider-envelope.ts`：openai-chat-completions（non-streaming，`choices` required array）與 anthropic-messages（`content` required array）的 strict Zod envelope schema，`.passthrough()` 未知／未來欄位，但必備欄位形狀錯誤 fail-closed。
- [x] envelope 驗證回 stable error code（`PROVIDER_ENVELOPE_INVALID`），不讀取其餘欄位。
- [x] 新增 test：合法 envelope、缺 `choices`、`choices` 非 array、`message` 形狀錯誤、`tool_calls` 形狀錯誤、未知額外欄位 passthrough、未來欄位不整包拒絕。

驗證命令：

```bash
cd backend
npm run test -- src/platform/provider-envelope.test.ts
npm run build
```

## T3 typed Tool argument decode 取代靜默 `{}`（backend）

> 依賴：T1。

- [x] 改寫 `llm-gateway.ts` 的 `parseOpenAiToolCalls` 回傳 `{ toolCalls: ToolCall[]; diagnostics: ToolCallDecodeDiagnostic[] }`；只有 decode 為 `valid` 的 entry 才進 `toolCalls`。
- [x] malformed entry 回 `ToolCallDecodeDiagnostic`（`missing_name`／`arguments_decode_failed`），不回 `{}` 也不靜默；只有 provider 真的回傳合法空物件才得空物件。
- [x] `AIMessage` 建構只取用 `toolCalls`；`diagnostics` 以 redacted 形式進入 audit／span。
- [x] `parseJsonResponse` 於 parse 失敗走 `decodeJsonText` 分類，`ProviderResponseParseError` 攜帶子類欄位（不改 name 語意）。
- [x] 既有 valid Tool-call fixtures（`llm-gateway.test.ts`、`mcp-agent.tool-calling.test.ts`）行為不變。
- [x] 新增 test：空 string、`{}` 合法空物件、截斷 JSON、`null`／array／number／boolean 型別不符、UTF-8 切斷、超長 arguments。

驗證命令：

```bash
cd backend
npm run test -- src/platform/llm-gateway.test.ts src/agents/mcp-agent.tool-calling.test.ts
npm run build
```

## T4 有界 incremental stream assembler（backend，standalone）

> 依賴：T1。

- [x] 新增 `platform/stream-assembler.ts`：`BoundedJsonStreamAssembler`（`push`／`end`／`abort`），維持 UTF-8 不完全位元組與 string/escape 狀態；`AssemblerResult = JsonDecodeResult<unknown>`（含 `aborted`）。
- [x] `push` 檢查 `maxBytes`／`maxDepth`／`deadline`／`signal`；超限或取消停止累積（不無界增長）。
- [x] `end()` 交由 `decodeJsonText` 做最終分類（與非串流路徑共用語意）。
- [x] 新增 test：JSON split between UTF-8 chunks、unterminated string、unterminated escape、EOS 前切斷、跨 chunk 多碼點、逾時／取消。
- [x] 本 Change 不接線 production streaming；assembler 為 standalone module。

驗證命令：

```bash
cd backend
npm run test -- src/platform/stream-assembler.test.ts
npm run build
```

## T5 最多一次 configured repair（backend）

> 依賴：T1、T3。

- [x] 建立 repair 入口：`incomplete` 自動構成 truncation evidence；`invalid` 須搭配 `finish_reason === "length"` 或 provider token-limit 診斷才構成 evidence；`too_large`／`aborted` 不 repair。
- [x] repair 最多一次；repair 候選 MUST 通過 strict JSON decode 且通過 Tool input schema，否則 exhaust；exhaustion 丟 `ToolArgumentDecodeError`（`code = "provider_decode_failure"`）。
- [x] content-filter refusal 與 parse/validation failure 分開處理，refusal 不得進入 repair。
- [x] 新增 test：一次修復成功、一次修復失敗後 exhaust、refusal 不 repair、取消中斷 repair、`too_large` 不 repair。

驗證命令：

```bash
cd backend
npm run test -- src/platform/
npm run build
```

## T6 provider error category 新增 decode failure 排除（backend）

> 依賴：T1。

- [x] 新增 stable category `provider_decode_failure`；`classifyProviderError` 依 `code`／`name`（非 message substring）分類，並以結構化欄位保留 `decodeKind`。
- [x] `isFallbackEligibleCategory("provider_decode_failure")` 回 `false`；`provider_response_invalid` 維持 `true`（envelope 形狀錯誤可 fallback）。
- [x] 於 `llm-gateway.ts` invoke retry loop 新增 guard：`classifyProviderError(lastError) === "provider_decode_failure"` 或 `lastError instanceof ToolArgumentDecodeError` 時 break（不 retry）。
- [x] 新增 test：`ToolArgumentDecodeError` → `provider_decode_failure` 且不 fallback、invoke retry 跳過 decode failure、`ProviderResponseParseError` → `provider_response_invalid` 仍 fallback、content-filter refusal 不落入 parse 分類。

驗證命令：

```bash
cd backend
npm run test -- src/platform/provider-error-category.test.ts
npm run build
```

## T7 redaction 與可觀測性（backend）

> 依賴：T1、T3。

- [x] 一般 log／hosted telemetry 只含 `provider`／`endpointKind`／`finishReason`／request correlation／`byteLength`／`rawHash`／`errorCode`。
- [x] 新增 architecture test：decode 診斷路徑不得 log raw Tool argument／raw provider body／未遮罩 PII。
- [x] 新增 test：診斷 payload 經 redaction 後不含 raw argument 內容。

驗證命令：

```bash
cd backend
npm run test -- src/platform/
npm run build
```

## T8 與 X14 pipeline 整合與回歸（backend）

> 依賴：T3、X14（已 archive）。

- [x] 確認 decode 失敗（`incomplete`／`invalid`／`too_large`／`aborted`）於 gateway 上游攔截，不產生 malformed `tool_calls`，不進入 X14 `inputSchema`。
- [x] 確認只有 `valid` `ToolCall.args` 才 dispatch；結構化診斷以 redacted 形式進入 audit／span。
- [x] 回歸：Weather／Web／Calculator／MCP 既有 golden eval／mock smoke／live smoke 路徑不變。

驗證命令：

```bash
cd backend
npm run test -- src/platform/ src/runtime/tool-dispatch/ src/agents/
npm run build
```

## T9 全量驗證與契約記錄（backend）

> 依賴：T1–T8。

- [x] 建立 cross-layer contract fixture：decode outcome（`valid`／`aborted`／`incomplete`／`invalid`／`too_large`／`refusal`）單一來源，供單元與 property test 共用。
- [x] 執行 backend 完整 lint／test／build，如實記錄 skipped／未驗證項與 live streaming 缺口。

驗證命令：

```bash
cd backend && npm run lint && npm run test && npm run build
```
