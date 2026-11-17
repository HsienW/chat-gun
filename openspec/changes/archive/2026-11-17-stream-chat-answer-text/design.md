# Design：一般聊天正文串流

## Context

一般聊天走 `chatbot` graph 的單一節點 `chat_response`。節點以 `llmGateway.createChatModel()` 取得 invoker，等待 `invoke()` 完成後回傳 `messages: [response]`。節點只取得 `RunnableConfig`，沒有 `ExecutionContext` 與 `RunSequenceAllocator`。

現況要點：

| 位置 | 行為 | 影響 |
|---|---|---|
| `backend/src/platform/llm-gateway.ts` | Qwen 與 OpenAI-compatible 共用 `OpenAiCompatibleChatModel`，以 `response.text()` 讀完整包；usage 由完整包取得；`supportsStreaming` 一律為 `false`。adapter 內有 `maxRetries` 重試迴圈與 tool argument 修復重送。 | 需新增串流解碼與發布邊界。 |
| `backend/src/platform/llm-fallback.ts` | `FallbackChatModelInvoker` 以 `Promise.race` 套 `perProviderTimeoutMs`（整次呼叫總時限）並切換 Provider。 | 落敗嘗試可能在中止前繼續寫入；總時限會切斷長回答。 |
| `StructuredOutputRepairChatModelInvoker` | 以修復提示重送。 | 第四個重試層。 |
| `backend/src/runtime/emit-envelope.ts` | 以 `ExecutionContext` 與 Run-scoped allocator 建立版本化 envelope；功能旗標關閉時回傳 legacy 事件。 | 正文事件沿用，但節點需接線。 |
| `bff/src/stream-passthrough.ts` | 逐塊轉送、背壓與斷線處理；未宣告防緩衝 header。 | 需明確宣告。 |
| `bff/src/demo/admission-policy.ts` | demo 強制 `on_disconnect=cancel`，`stream_resumable` 僅可缺省或 `false`。 | demo 斷線即取消，無終稿可同步。 |
| `frontend/src/App.tsx` | `onUpdateEvent` 在 `showActivityTimeline` 關閉時提前返回；版本化事件經 `BoundedRuntimeEventBuffer` 後只進活動流程。 | 正文需獨立入口與獨立順序依據。 |
| `frontend/src/lib/runtime-event-envelope.ts` | `BoundedRuntimeEventBuffer` 依 Run `sequence` 重排，缺口等待至補齊或超出 `windowSize`。 | 不能作為正文閘門。 |
| `frontend/package.json` | `@langchain/langgraph-sdk` 為 `^0.0.74`。 | custom 訂閱能力與 `streamMode` 需以鎖定版本驗證。 |

## Goals / Non-Goals

見 proposal「範圍」。

## Decisions

### D1：採用 Gateway sink + LangGraph custom 事件

| 方案 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| A. Gateway `answerTextSink` + LangGraph custom 事件 | 只有明確選用的節點公開正文；規劃、結構化輸出、工具參數不外洩；重用版本化事件、ownership 與治理。 | 前端需自建正文 reducer；需證明 custom 事件能穿過 wrapper 與 SDK。 | 採用 |
| B. LangGraph 原生 `messages` 模式（LangChain callback `handleLLMNewToken`） | `useStream` 原生依 message ID 合併。 | 現有 invoker 直接 `fetch`，不經 callback，需重寫 adapter；預設串出所有模型呼叫，只能靠 tag 排除，漏標即外洩；不帶版本化 envelope、ownership、generation。 | 不採用；若未來改用 LangChain chat model 再評估 |
| C. 另開第二條 HTTP 正文串流 | 與 LangGraph 傳輸解耦。 | 順序、取消、認證、限流、計量都要重做；違反「一次點擊一次邏輯生成」。 | 不採用 |

一個點擊只發起一次邏輯生成。模型呼叫期間以版本化 `model.stream` 傳遞**暫時正文**；成功後由節點提交帶相同訊息 ID 的**最終 `AIMessage`**，作為歷史與下一輪輸入。片段不逐一寫入 Graph State。

### D2：Gateway 正文 sink 契約（backend）

`ChatModelInvokeOptions` 新增選用欄位 `answerTextSink?: AnswerTextSink`。`invoke` 回傳型別不變，既有 caller 不受影響。

```ts
export interface AnswerTextSink {
  readonly messageId: string;
  readonly hasPublished: boolean;
  beginAttempt(attempt: AnswerStreamAttempt): AnswerTextAttemptWriter;
}

export interface AnswerTextAttemptWriter {
  append(textDelta: string): Promise<void>;
  seal(outcome: "completed" | "abandoned"): void;
}

export type AnswerStreamAttempt = {
  provider: LlmProviderName;
  attemptIndex: number;
};
```

- 每次實際上游嘗試先 `beginAttempt()`，於 `finally` 呼叫 `seal()`。封存後的 `append` 不寫入，記錄 `answer.stream.late_delta_dropped` 指標。
- 第一次成功 `append` 後 `hasPublished` 為 `true`，不可回復。
- `answerTextSink` 只允許與無 `responseFormat`、未 `bindTools` 的呼叫並用；不合法組合於呼叫前拋出可分類的設定錯誤，不得靜默忽略。
- 能力判斷由 Gateway 依端點協定、用途、已驗證 capability 與發布設定決定；MUST NOT 依模型名稱、回答用語或文字前綴判斷。
- Provider 層的 `attemptIndex` 只記在 sink，不覆寫 envelope context 的 Run `attempt`。

### D3：發布後禁止透明重試（backend）

新增共用判斷 `isRetryBlockedByPublishedAnswer(invokeOptions)`，由下列四層在捕獲錯誤時先行檢查：

1. `OpenAiCompatibleChatModel` 的 `maxRetries` 迴圈。
2. 同一 adapter 的 tool argument 修復重送。
3. `StructuredOutputRepairChatModelInvoker`。
4. `FallbackChatModelInvoker`。

`hasPublished` 為 `true` 時，原錯誤包成 `AnswerStreamInterruptedError`（錯誤碼 `answer_stream_interrupted`，保留 `cause` 與失敗階段）直接上拋。`classifyProviderError` MUST 將此類別判定為不可 fallback。這涵蓋「已交付但回傳失敗」的不確定情況。

### D4：LangGraph 到瀏覽器的橋接（backend + frontend）

- **傳輸**：節點執行期間，sink 的 writer 接至該次執行的 LangGraph custom writer，經 SDK `custom` 串流模式抵達瀏覽器；最終 `messages` 走既有狀態通道。
- **閘門**：第一個實作 Task 必須證明 Agent Server、`applyInteractionGovernance`、`instrumentGraphWithUsageAttribution` 與鎖定版本的前端 SDK 能在節點返回前傳遞 custom event，並保有既有模式。未證實前，不得以節點完成後的 `updates` 當作證據。
- **替代橋**：若 custom writer／訂閱不能穿過既有 wrapper，保留 sink 與事件契約，在 Runtime 與前端 transport 邊界各留一個 adapter，先以固定版本的真實 Runtime fixture 證明替代橋能提早送達，再開啟。若 SDK 原生訊息片段與 custom 正文同時抵達，同一回答只指定一個增量來源，完整狀態按 ID 對帳。不並行啟動第二條 HTTP 請求。若替代橋亦不可行，停止並回報 CCR。
- **執行環境接線**：sink 以既有 composition root 提供的 `ExecutionContext` 與 `RunSequenceAllocator` 建立，節點內 MUST NOT 自行建立 allocator。功能啟用但接線缺失時 readiness 回報失敗，而非每個請求靜默降級。
- **chatbot 接線決策（Master 於 2026-11-15 核准）**：Task 4 開工時確認，正式環境的 `chatbot` graph 沒有 `ExecutionContext`，也沒有可共用的 `RunSequenceAllocator`。處置如下：
  - `chatbot` 比照 `deep_researcher` 接上 `instrumentGraphWithExecutionContext`、`createGraphEntryContextResolver`（`PgGraphTaskAdmission`）與 identity status instrumentation。包裝順序為 usage attribution → execution context → interaction governance → compiled graph。因此 `chatbot` 從此需要 BFF 的 trusted principal headers 與 Postgres task admission，與其他已接線的 graph 一致。
  - allocator 由 Runtime 模組提供單一 process 範圍的實例，在 graph 組裝時注入節點，節點內不得自建（符合 KL-1 單一 process 假設）。正文事件與其他事件來源使用的 allocator 不同，同一 Run 的 `sequence` 只保證在正文事件之間單調遞增；依 D6，`sequence` 不作為放行閘門，去重以 `eventId` 與 `(messageId, textOffset)` 為準。
  - 功能以 `ANSWER_TEXT_STREAMING_ENABLED` 啟用，預設關閉，依 D5「消費端先部署，再開啟後端發送」。readiness 在功能啟用時檢查 envelope 已啟用、`chatbot` 接線已登記；任一缺失回報失敗。
- **關聯**：開始生成前由後端配置穩定 `messageId`，終稿沿用。Envelope 沿用可信 context 的 `threadId`、`runId`、`requestId`、`attempt`；Run ownership 與 generation 沿用既有互動治理。

### D5：`model.stream` payload 擴充（外部契約）

以選用欄位擴充：`payload.messageId`、`payload.outputKind = "answer_text"`、`payload.textOffset`。三者與合法 `delta` 齊備才進入正文路徑；舊版只有 `delta` 的事件沿用活動用途。

**閘門**：確認 `@gun-ai/harness-contracts` 的 `model.stream` payload schema 能否保留新增欄位。若為 strict，先協調契約版本發布，消費端先部署，再開啟後端發送。

**閘門結果（2026-11-03，`implementation-gate-evidence-01`）**：`@gun-ai/harness-contracts@0.1.0-alpha.3` 的 `model.stream` schema 為 strict，帶三個新欄位的 payload 以 `unrecognized_keys` 被拒。

**選定路徑（Master 於 2026-11-04 核准）**：在上游 `gun-harness` 擴充契約，不在 chat-gun 繞過。

- 上游 `@gun-ai/harness-contracts` 為 `model.stream` 新增三個**選用**欄位並附 runtime validation：`messageId`（非空字串）、`outputKind`（封閉 enum，本 Change 只使用 `answer_text`）、`textOffset`（非負整數）。既有只有 `delta` 的 payload MUST 仍然有效；schema 維持 strict，其他未知欄位仍然拒收。
- 上游 `@gun-ai/harness-kernel` 解析與轉送 envelope 時 MUST 保留這三個欄位，不得剝除。
- 依 `harness-package-boundary` 由 Human 核准，依 contracts → kernel →（若受影響）testkit 順序發布新的精確 alpha 版本。
- chat-gun 依 `harness-consumer-integration` 於同一增量升級精確版本與 lockfile 並完成 adapt（Task 1.7）。
- MUST NOT 在 chat-gun 以本地平行 schema、放寬驗證、`passthrough`、把欄位編進 `delta` 字串或其他特殊分支繞過此閘門。

上游擴充與發布屬 `gun-harness` 的工作，不在本 Change 的程式修改範圍；本 Change 只承接已發布版本。上游未發布前，Task 1.7 與其後任務 MUST NOT 開始。

### D6：順序與去重

- `eventId` 用於去重；`sequence` 為整個 Run 的順序，用於去重與診斷，**不作為正文的放行閘門**。
- 正文唯一順序依據為 `(messageId, textOffset)`。`textOffset` 為本訊息先前已發布文字的 UTF-16 code unit 數，與 JS 字串長度一致；第一段為 0。偏移在 D7 增量 UTF-8 解碼與 surrogate 暫留之後計算，不使用傳輸層 byte 偏移或 chunk 邊界。
- 重播沿用原身分；暫時正文不承諾跨重新整理重播。

### D7：串流解碼、surrogate 與計量（backend）

- 首條垂直路徑採共用 OpenAI-compatible adapter，先驗證一個實際部署端點。發出串流請求、檢查 HTTP 狀態與媒體型別，逐框驗證，只發布所選回覆的可見文字；角色、心跳、usage、推理內容（如 `reasoning_content`）、工具參數各走自己的分支。
- SSE 框以增量 UTF-8 解碼並保留未消費資料，支援跨 chunk 的多位元組字元、CRLF、同 chunk 多框、單框多行 `data:`；依框界線取得完整 payload 才 parse。EOF 截斷的框回報不完整；完整框內非法 JSON 回報協定解析失敗。
- delta 結尾為單獨高位 surrogate 時暫留，與下一個 delta 合併後再發布；結束時仍未配對依協定錯誤處理。
- 最終訊息由同一份已接受片段組成；依端點完成訊號與結束原因判定成功、截斷或拒答。空片段或 HTTP EOF 本身不足以判成功。
- 端點宣告 `supportsStreamUsage` 時才送 `stream_options: { include_usage: true }`。每次實際上游嘗試於 `finally` 恰好呼叫一次 `recordProviderUsage`；中止或缺尾框時 token 記為缺值並帶 `usageMissingReason: "stream_aborted" | "usage_frame_missing"`。
- **缺值原因的承接（Task 1.5 結論，Master 2026-11-11 採方案 A）**：Task 1.5 確認現有 usage ledger（`model-usage-ledger`，`usage-ledger@1`）不能承接缺值原因：`ProviderUsage`／`UsageLedgerRecord` 沒有原因欄位。ledger 在儲存層只累加彙總值（`amountMicros`、`unpricedCount` 及依 graph／callKind 分組的同名欄位），不保存單筆紀錄，所以原因只需在計量事件上保留，不改儲存格式：
  - `ProviderUsage` 新增選用欄位 `usageMissingReason`，型別為封閉 enum `UsageMissingReason`，單一來源定義於 usage 模組，值為 `"stream_aborted" | "usage_frame_missing"`。非串流路徑不帶此欄位，行為不變。
  - token 缺值時，`usage_missing` 事件 MUST 帶上該原因；未帶原因時事件維持現狀。原因不參與計價，`estimated`／`unpriced` 判定與金額累加完全不變。
  - token 齊全時帶原因屬呼叫端錯誤，ledger MUST 忽略該原因、不改變入帳，並以測試固定。執行期收到不在 enum 內的值時，MUST 記為未知原因 `unknown`，不得拋錯中斷計量。
  - 儲存格式、Redis key 與彙總欄位不變，`usage-ledger@1` 不升版。若日後需要依原因統計，屬另立 Change。
  - 契約變更以本 Change 的 `model-usage-ledger` delta spec 表達，由 Task 3.3 實作。
- 包裝 `invoke` 的 tracing、metrics、usage attribution MUST 傳遞 options 並保留取消訊號。

### D8：串流逾時（backend）

| 設定 | 語意 | 與既有設定的關係 |
|---|---|---|
| `llmStreamFirstChunkTimeoutMs` | 送出請求到第一個可見片段 | 未發布前仍可依既有政策重試或 fallback；sink 存在時 `FallbackChatModelInvoker` 以此取代 `perProviderTimeoutMs`。 |
| `llmStreamIdleTimeoutMs` | 兩個片段之間的最大停滯 | 心跳、角色框、usage 框不重設。 |
| `llmStreamTotalDeadlineMs` | 單次串流總時限 | 不得超過 Run deadline；任何框不得展延。 |
| `llmStreamMaxPendingBytes` | 解碼待處理緩衝上限 | 與 `llmProviderResponseMaxBytes`、`llmJsonMaxDepth` 並存。 |

設定集中於 runtime config 並驗證範圍。預設值與上下限依 OQ3 決策，由 Task 3 依目標端點實測首段延遲決定，回填「Resolved Questions」的 D8 預設值表。逾時一律經 `AbortSignal` 中止 reader，不得只停止讀取而殘留上游連線。

### D9：降級與可觀測性（backend）

- 能力不支援或功能停用時，呼叫前選用整段回覆，記錄 `answer.stream.degraded{reason}`。`reason` 為封閉 enum：`capability_unsupported`、`feature_disabled`、`execution_context_missing`、`writer_missing`、`envelope_disabled`、`final_moderation_required`；未知值歸入 `unknown`。
- 請求成功但端點只回合法整包 JSON：經大小與 Schema 驗證後交付並記錄降級原因；不計入串流驗收。宣告支援卻回錯誤格式：回報協定錯誤。
- 同一 Run 分別量測模型首段、Runtime 發出首段、瀏覽器顯示首段的耗時，各端使用單調時鐘，以 request/run 關聯。
- 日誌只記階段、識別字、時間、數量與錯誤分類，不記正文、原始工具參數或憑證。

### D10：BFF 防緩衝（bff）

上游為 `text/event-stream` 時，passthrough 明確加上 `X-Accel-Buffering: no` 與 `Cache-Control: no-cache, no-transform`，並確認沒有壓縮中介層緩衝；以契約測試固定。部署端代理另行於 live smoke 驗證。

### D11：前端正文消費（frontend）

- **SDK**：依 lockfile 確認實際版本並改為精確版本；確認 custom 訂閱能力；記錄每個 agent 加入訂閱前後實際請求的 `streamMode`。
- **入口**：custom 資料入口做 runtime validation，核對當次 request、thread 與權威 Run；ownership 尚未到達可短暫有界暫存。此處理獨立於 `showActivityTimeline`。
- **分流**：合法 `answer_text` 事件同時交給兩個消費者：
  - 正文 reducer：抵達即依 `textOffset` 套用，不等待 Run 序號缺口。
  - `BoundedRuntimeEventBuffer`：照常收下以維持序號連續；活動流程輸出端略過 `outputKind = "answer_text"`，避免時間軸重複顯示正文。
- **分流修訂（2026-11-15，承接 D4 chatbot 接線決策）**：正文事件改用自己的 allocator，`sequence` 與同一 Run 的其他事件各自從 1 起算。如果放進同一個 `BoundedRuntimeEventBuffer`，會被當成重複或缺號，干擾其他事件的排序。因此正文事件**不進入** `BoundedRuntimeEventBuffer`，只交給正文 reducer；活動流程在入口略過 `outputKind = "answer_text"`。去重依 D6，以 `(messageId, textOffset)` 為準。
- **草稿**：以 `(threadId, runId, messageId)` 識別；第一段即顯示，保留合法空白與換行；重複片段只套用一次；缺段於 `answerDraftGapWaitMs` 內有限等待，超窗或內容衝突則保留可證明前綴並等待權威快照。
- **終稿對帳**：`thread.messages` 出現相同 ID 時，於同一次展示計算以權威內容取代草稿並移除暫存；終稿先到則封住同 ID 晚到片段。只收到結束通知時做一次有界狀態同步。
- **渲染**：穩定 message ID 作為 React key；高頻片段按繪製週期合併，終止或卸載時清理排程；僅在使用者原本貼近底部時跟隨。每一幀交給同一個安全 Markdown 渲染器；不另寫「未閉合」偵測（CommonMark 已將未閉合 fence 視為延伸至結尾的程式碼區塊），避免版面跳動與以 Regex 判斷結構。
- **文案**：使用者可見狀態一律由錯誤碼經文案目錄產生，不從文字反推狀態。

### D12：失敗、取消、斷線與拒答

| 異常 | 系統處理 | 使用者結果 |
|---|---|---|
| 建連失敗、認證拒絕、限流、載入 thread 失敗 | 沿用 admission、BFF、SDK 結構化錯誤通道，保留錯誤碼、可重試性與 request ID。 | 結束等待並保留輸入；限流顯示可重試時間。 |
| 首段前逾時或 Provider 暫時失敗 | `hasPublished` 為 `false` 時才依既有政策有限重試或 fallback，受首段逾時與總時限約束；不重試取消、拒絕或無效輸入。 | 最終失敗顯示對應原因並解除輸入鎖定。 |
| 已發布後斷線、逾時、格式錯誤、writer 拒絕 | 依 D3 拋出 `AnswerStreamInterruptedError`，中止上游並交由 Run 錯誤處理。BFF 自身失敗依 headers 是否已送出選擇安全 JSON 或 SSE 終止錯誤。 | 保留已顯示片段並標記中斷或逾時。 |
| 瀏覽器斷線或重新整理 | **完整 profile**：Run 依 `on_disconnect` 繼續時，重新載入後讀取 thread 狀態對帳，必要時有界輪詢；鎖定 SDK 支援加入既有串流時才使用。**demo profile**：Run 已取消，不提供重新同步。 | 完整 profile 顯示終稿或「仍在處理」；demo 顯示「已中斷」並保留片段，只提供使用者明確觸發的重新生成（新 Run）。 |
| 取消、切換對話、新 Run 取代舊 Run | 沿用 `thread.stop()` 與既有 cancel／ownership 路徑，傳遞 `AbortSignal`，於 `finally` 清理 reader、timer、listener、緩衝並封存 sink。 | 立即停止追加；晚到片段、終稿或舊 generation 不寫入新泡泡。 |
| 串流途中拒答（如 `finish_reason === "content_filter"`） | 使用正文專屬分類 `answer_stream_refused`，不沿用 `StructuredOutputRefusalError`。節點不提交含已發布片段的 `AIMessage`，片段不進入歷史與下一輪輸入。需終稿審核才能揭露正文的端點以 capability 宣告，呼叫前降級（`final_moderation_required`）。 | 依 OQ1 決策收回草稿：同一泡泡移除已顯示片段，改顯示由錯誤碼產生的拒答提示；重新載入後只見拒答提示，不見片段。可分辨「被拒答」與「連線中斷」。 |
| 解碼器、渲染函式失敗或未知事件版號 | 在所屬邊界捕獲並保留 cause，上傳可分類錯誤；單一不可渲染內容降級為安全文字或既有錯誤元件；未知事件沿用現行降級。 | 使用者可分辨內容受限或整次中斷；console 只供診斷，不取代使用者提示。 |

**斷線恢復修訂（Master 於 2026-11-16 決定）**：
- 鎖定的前端 SDK（`@langchain/langgraph-sdk` 0.0.74）提交 Run 時預設送出 `on_disconnect: "cancel"`，demo admission 也強制要求此值；這版 SDK 也沒有加入既有串流的能力。因此目前兩種 profile 的 Run 都會在斷線時取消，上表「完整 profile 讀取 thread 狀態對帳」的前提不成立。Master 決定維持 `cancel`，不改變 Run 生命週期與成本。
- profile 由 BFF 提供：`GET /api/application-profile` 回傳 `{ "schemaVersion": "1", "profile": "demo" | "full" }`。值由 BFF 唯一的部署開關 `DEMO_ENABLED` 決定，回應不快取；非 GET／HEAD 回 405。前端讀取失敗或收到未知值時視為 `demo`（fail closed）。
- 前端以集中、封閉的對照表把 profile 對應到恢復方式。目前 `demo` 與 `full` 都對應 `regenerate_only`：斷線、中斷或逾時的草稿保留片段並標記，只提供使用者明確觸發的「重新生成」。日後若完整 profile 改用 `on_disconnect: "continue"`，再將 `full` 改為 `thread_resync`，屬另立 Change。
- 「重新生成」沿用一般提交路徑，以最後一則使用者文字訊息建立新的 Run，所以歷史中會再出現一次該問題。最後一則使用者訊息含附件（非純文字）時不提供，避免遺失附件；被拒答的草稿也不提供。

**錯誤碼傳遞（2026-11-15 補充）**：Agent Server 把節點拋出的錯誤序列化為 `{ error: name, message }`，前端既有的結構化通道會把 `message` 解析為 ErrorEnvelope。所以 `chatbot` 節點會把 `answer_stream_interrupted` 與 `answer_stream_refused` 轉成 `message` 為 ErrorEnvelope JSON 的錯誤：`source = "backend"`、`stage = "chat_response"`、`code` 為上述兩者之一。中斷時以 `cause.code` 帶出可分類的原因，例如 `answer_stream_idle_timeout`。envelope 不帶原始 Provider 訊息或正文。前端依 `code` 與 `cause.code` 從文案目錄產生「已中斷」「逾時」「拒答」提示。

### D13：三種輸入分開解碼

| 輸入 | 接收途中 | 結束時 |
|---|---|---|
| Provider SSE 事件框 | 見 D7。 | 截斷回報不完整；非法 JSON 回報協定解析失敗。 |
| 結構化輸出或工具參數 | 本 Change 維持既有整段路徑，且不得與 sink 並用。未來接入時重用 `BoundedJsonStreamAssembler` 的 byte、depth、deadline、abort 與 `end()` 語意。 | 收到完成訊號並通過 JSON 與 Schema 後才執行；不自行補括號，不對部分參數呼叫函式。 |
| 模型寫給使用者的正文 | 只取自已驗證的公開文字欄位；模型在寫 JSON 範例或 Markdown 時照常追加。 | 忠實顯示終稿，不做 JSON 修復。 |

## 發布與回滾

1. 先部署能安全忽略新欄位的消費端（含活動流程略過正文）。
2. 若 D5 需要，發布契約新版本。
3. 依 endpoint capability 與功能開關開啟後端發送。

回滾時停止新 Run 啟用正文串流；進行中的 Run 維持開始時的模式；已保存訊息由原路徑讀取。

## 安全

- 正文只來自已驗證的公開文字欄位；推理內容、工具參數、結構化輸出不進入正文。
- sink 只能由明確選用的節點傳入；Gateway 拒絕與工具或結構化輸出並用。
- 日誌與指標不含正文與憑證。
- 前端不持有任何 Provider 憑證；所有串流仍經 BFF。

## Risks / Trade-offs

見 proposal「風險」。額外取捨：串流途中拒答時，使用者已看見的內容無法真正收回；需終稿審核的端點因此不得串流。

## Resolved Questions（Master 於 2026-11-03 決定）

| # | 問題 | 決策 | 落地位置 |
|---|---|---|---|
| OQ1 | 串流途中被拒答時，已顯示的片段如何處理 | 收回草稿，改顯示拒答提示，避免保留可能被審核攔下的內容。片段不寫入歷史。 | D12 拒答列；spec「串流途中拒答」；Task 3.4、6.5、7.2 |
| OQ2 | demo profile 斷線後如何恢復 | 只提供重新生成，依目前 admission 政策。支援重新同步列為後續待辦 FU-1。 | D12 斷線列；spec「依 application profile 的斷線恢復」；Task 6.5、7.2 |
| OQ3 | 逾時與緩衝預設值 | Task 3 實作時依目標端點實測首段延遲決定，結果回填本 design D8，並作為 Task 7.3 首段可見延遲的放行上限。 | D8；Task 3.1、7.3 |
| OQ4 | 多 worker 下序號的作用範圍 | 由 Task 1.6 確認。目前部署沒有多 worker／多 session，記錄為已知限制 KL-1；多 worker／多 session 支援列為後續待辦 FU-2。 | Task 1.6；本節「已知限制」 |

D8 預設值（Task 3 回填）：

| 設定 | 預設值 | 下限 | 上限 | 實測依據 |
|---|---|---|---|---|
| `llmStreamFirstChunkTimeoutMs` | 10000 | 2000 | 60000 | 首段延遲 554–2702 ms（p50 2097 ms）；預設約為最大值的 3.7 倍。依 OQ3，同時作為 Task 7.3 首段可見延遲的放行上限。 |
| `llmStreamIdleTimeoutMs` | 15000 | 3000 | 120000 | 相鄰片段最大間隔 2835 ms，各次 p95 為 154–417 ms；預設約為最大值的 5 倍。 |
| `llmStreamTotalDeadlineMs` | 180000 | 10000 | 600000；另須不超過 Run deadline | 約 500 字的回答最長 8156 ms（280–318 output tokens）；以 `maxOutputTokens` 8192 依實測速率推估約 140 s，預設保留餘裕。 |
| `llmStreamMaxPendingBytes` | 262144 | 4096 | 4194304 | 實測每框只有數個字，未量測框的 byte 大小；預設值遠大於單框大小，並受 `llmProviderResponseMaxBytes` 限制。 |
| `answerDraftGapWaitMs` | 3000 | 500 | 不得超過 `llmStreamIdleTimeoutMs` | 依相鄰片段最大間隔 2835 ms；前端設定，由 Task 6.2 實作。 |

實測方式（Task 3.1，2026-11-15）：`answer-stream-latency.live.test.ts` 經真正的 Gateway 串流路徑，對部署端點（provider `qwen`，host `dashscope.aliyuncs.com`，模型 `qwen3.5-flash`，thinking 關閉）連續送出 5 次約 500 字的純文字請求。5 次都以 `stop` 完成，每次 87–96 段，都收到 usage 尾框。evidence 見 `.agent-runtime/stream-chat-answer-text/artifacts/task3-1-latency-ccr.json`，只記時間、片段數與 usage，不含正文。

限制：樣本只有單一時段的 5 次；runtime config 目前沒有 Run deadline 設定，「不超過 Run deadline」尚無可比對的來源。量測的是 backend 收到第一段的時間，不是瀏覽器顯示的時間；後者由 Task 7.3 量測。

### 已知限制

- **KL-1**：`RunSequenceAllocator` 為單一 process 範圍。本 Change 假設單一 LangGraph worker（單 session）部署；多 worker 下同一 Run 的序號連續性不在本 Change 保證範圍。Task 1.6 的確認結果須回填此處；若發現目前部署已是多 worker，停止並回報 CCR。
  - **Task 1.6 確認結果（2026-11-09）**：
    - `RunSequenceAllocator` 由 `@gun-ai/harness-kernel` 提供，以 process 內的 `Map` 依 `runId` 計數（預設 TTL 30 分鐘、上限 10,000 筆），不跨 process 共享。
    - `docker-compose.yml` 只有一個 `langgraph-api` 容器，未設定 replicas 或 worker 數；Agent Server 啟動時的「Starting 10 workers」是同一 process 內的並行 run，共用同一個 allocator 實例。
    - 正式程式目前沒有建立 allocator 的位置：`execution-composition-root` 只接受注入，`chatbot` 節點未接線。Task 4 依 D4 由 composition root 提供，不得在節點內自建。
    - 結論：目前部署不是多 worker／多 session，未觸發停止條件。
  - **補充證據（2026-11-11，implementation-result-ccr-04）**：
    - 本機 `@langchain/langgraph-api` 1.4.5 的 `dist/server.mjs` 以 `for (let i = 0; i < nWorkers; i++) queue(ops)` 啟動 worker；`dist/queue.mjs` 的 `queue` 是 async `while` 迴圈。所以「N workers」是同一 Node process 內的並行迴圈，不是 thread 或子 process，module 層級狀態（含 allocator 的 `Map`）由它們共用。`worker_threads` 只用於 graph parser，與 run 執行無關。
    - `docker-compose.yml` 的 `langgraph-api` 以 `Dockerfile` target `langgraph-api`（`FROM docker.io/langchain/langgraphjs-api:22`）建置，為單一 service，沒有 `deploy`／`replicas`／`scale` 設定。
    - 未驗證：正式映像檔 `langchain/langgraphjs-api:22` 內含的 langgraph-api 版本與 worker 實作未實測。部署前若映像檔改為多 process，屬 FU-2 範圍，本 Change 的序號保證不適用。

### 後續待辦（不在本 Change 範圍）

- **FU-1：demo profile 斷線後重新同步。** 需另立 Change，調整 demo admission 的 `on_disconnect` 與 `stream_resumable` 政策，並評估成本防護與濫用風險。
- **FU-2：多 worker／多 session 部署下的事件序號。** 需另立 Change，決定 Run-scoped allocator 的跨 process 協調方式（例如共享儲存或以 worker 範圍分段），並補齊跨 worker 的去重與重排測試。
