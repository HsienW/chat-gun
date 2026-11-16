# Tasks：一般聊天正文串流

> 每個 Task 完成時必須附上實際執行的命令與結果。未執行的驗證必須明確列出，不得勾選。Task 1 為閘門；任一閘門失敗時依 design D4 停止並回報 CCR，不得以替代證據繼續。

## 1. 閘門：固定失敗案例與橋接能力（design D4、D5、D7、D11）

- [x] 1.1 建立可控制的 Provider fixture：送出合法第一框後等待測試放行，才送第二框與結束框。經真正的 Gateway、LangGraph Server、BFF 與瀏覽器送出一般聊天，記錄目前首段停在哪一層（evidence）。（2026-11-09：首段停在 backend Gateway，Gateway 以 `stream: false` 請求並讀完整包；閘門期間 Server 只送出 `metadata`／`values`，瀏覽器無正文。見 `task1-1-*` evidence。）
- [x] 1.2 以最小 custom writer 驗證 custom 事件能在節點返回前，穿過治理 wrapper 與 usage attribution wrapper 抵達瀏覽器，且既有串流模式不變。不得以節點完成後的 `updates` 作為證據。（2026-11-09：真實 Server＋BFF＋瀏覽器中 custom 於 30 ms 抵達、節點 `updates` 於 4034 ms；wrapper 路徑另以 gate 測試固定。見 `task1-2-*` evidence。）
- [x] 1.3 依 lockfile 確認前端 LangGraph SDK 實際版本並改為精確版本；確認 custom 訂閱能力；記錄每個 agent 加入訂閱前後實際請求的 `streamMode`。（2026-11-09：`@langchain/langgraph-sdk` 鎖定 `0.0.74`；各 agent 由 `messages-tuple`／`values`／`updates` 增為加上 `custom`，`onCustomEvent` 可用。）
- [x] 1.4 確認 harness-contracts 的 `model.stream` payload schema 能否保留新增欄位；若為 strict，記錄所需的契約版本發布步驟並回報 CCR。（2026-11-03 已確認 `0.1.0-alpha.3` 為 strict，見 `implementation-gate-evidence-01`；路徑依 design D5「選定路徑」。本 Task 於 Task 1.7 的 probe 通過後才可勾選。）
- [x] 1.5 確認 usage ledger 能承接缺值原因欄位；不能時回報 CCR。
- [x] 1.6 確認 `RunSequenceAllocator` 在目前部署形態下的作用範圍，結果回填 design「已知限制」KL-1。若發現目前部署已是多 worker／多 session，停止並回報 CCR（多 worker 支援屬後續待辦 FU-2）。
- [x] 1.7 前置條件：上游 `@gun-ai/harness-contracts` 與 `@gun-ai/harness-kernel` 已依 design D5 發布含三個選用欄位的新精確 alpha 版本，且可從公開 registry 匿名安裝。前置條件未滿足時 MUST 停止並回報 CCR，不得以本地 `file:` 連結、pack、dry-run 或 sibling checkout 代替。滿足後，於同一增量：
  - 將 `backend/package.json` 的兩個套件改為新的精確版本並更新 lockfile；不得使用版本範圍。
  - 以 Task 1.4 相同的 probe 驗證：只有 `delta` 的 payload 通過；帶三個新欄位的正文 payload 通過；未知欄位仍被拒；`textOffset` 為負數、`outputKind` 為未知值時被拒。
  - 驗證 kernel 經 envelope 解析與轉送後三個欄位仍保留。
  - 依 `harness-consumer-integration` 完成 adapt，不新增平行本地定義，`chat-gun-parallel-local-definition` 檢查通過。

驗證：`cd backend && npm run test`；Task 1.7 另需 `cd backend && npm run lint && npm run test && npm run build` 全綠，並保存 registry 安裝來源與 probe 結果；evidence 存放於 `.agent-runtime/stream-chat-answer-text/` 並以 ArtifactReference 引用。Task 1.1 的瀏覽器正文斷言（閘門期間瀏覽器沒有正文）不在 Task 1 以 `test:e2e` 驗證，改由 Task 7.1 的跨層 E2E 承接（Master 2026-11-11 決定 E1）。

## 2. Gateway 正文 sink 與重試邊界（design D2、D3）

- [x] 2.1 新增 `AnswerTextSink`、`AnswerTextAttemptWriter`、`AnswerStreamAttempt` 與 `ChatModelInvokeOptions.answerTextSink`；封存後寫入丟棄並記錄 `answer.stream.late_delta_dropped`。
- [x] 2.2 sink 與 `responseFormat` 或 `bindTools` 並用時，於呼叫前拋出可分類設定錯誤。
- [x] 2.3 新增 `isRetryBlockedByPublishedAnswer` 與 `AnswerStreamInterruptedError`（`answer_stream_interrupted`），接入 adapter 重試迴圈、tool argument 修復重送、結構化輸出修復與 Provider fallback 四層；`classifyProviderError` 判定為不可 fallback。
- [x] 2.4 tracing、metrics、usage attribution 包裝層傳遞 sink 與取消訊號。（usage attribution 不包裝 invoker，只經 `options.attribution` 傳遞，故無需新增包裝；Traced／Metric／Fallback 傳遞以測試固定。）

（2026-11-14，CCR implementation_secondary，handoff-apply-task2-8-03-ccr：`answer-text-sink.test.ts` 20/20；`cd backend && npm run lint && npm run test && npm run build` 全綠，299 files／2453 passed／118 skipped。tool argument 修復重送的阻擋因 sink 與 `bindTools` 互斥而屬防禦性檢查，無法以合法組合觸發，未另寫測試。evidence：`task2-backend-*-ccr.txt`。）

驗證：`cd backend && npm run lint && npm run test && npm run build`。測試須涵蓋：發布後四層皆不重試；逾時落敗嘗試的晚到片段被丟棄並計數；不合法組合拋錯；未傳 sink 的既有 caller 行為不變。

## 3. OpenAI-compatible 串流解碼、逾時與計量（design D7、D8、D9）

- [x] 3.1 新增 `llmStreamFirstChunkTimeoutMs`、`llmStreamIdleTimeoutMs`、`llmStreamTotalDeadlineMs`、`llmStreamMaxPendingBytes` 至 runtime config 並驗證範圍；sink 存在時 fallback 以首段逾時取代 `perProviderTimeoutMs`。依 OQ3 決策，以目標端點實測首段延遲決定各設定與 `answerDraftGapWaitMs` 的預設值與上下限，回填 design「Resolved Questions」的 D8 預設值表，並保存量測 evidence。
  （2026-11-15，完成：
  - 四個設定、範圍與交叉驗證（首段／閒置不得超過總時限），以及 sink 存在時 fallback 改用首段逾時、發布後不再中止，都已實作並有測試。
  - Master 同意後，以 `answer-stream-latency.live.test.ts`（opt-in，`vitest.live.config.ts`）對部署端點 `qwen`／`qwen3.5-flash` 實測 5 次：首段 554–2702 ms，相鄰片段最大間隔 2835 ms，最長 8156 ms，5/5 收到 usage 尾框。
  - 預設值與上下限已回填 design D8；`answerDraftGapWaitMs` 的建議值 3000 ms 由 Task 6.2 實作。evidence：`task3-1-latency-ccr.json`。
  - 差異：runtime config 沒有 Run deadline 設定，「總時限不得超過 Run deadline」尚無可比對的來源；樣本只有單一時段的 5 次。
  - 驗證：調整預設值後 `cd backend && npm run lint && npm run test && npm run build` 全部通過，301 files，2500 passed，119 skipped。evidence：`task3-1-backend-*-ccr.txt`。）
- [x] 3.2 在 OpenAI-compatible adapter 實作串流解碼：增量 UTF-8、SSE 框界線、完成標記、usage 框、推理內容與工具參數分流、surrogate 暫留；逾時經 `AbortSignal` 中止 reader。
- [x] 3.3 新增 `supportsStreamUsage` capability；支援時送出 `stream_options.include_usage`；每次上游嘗試於 `finally` 恰好計量一次，缺值帶 `usageMissingReason`。依 design D7「缺值原因的承接」與 `model-usage-ledger` delta spec：在 usage 模組以單一來源定義封閉 enum `UsageMissingReason`（`stream_aborted`、`usage_frame_missing`），`ProviderUsage` 新增選用欄位，`usage_missing` 事件帶上原因，集合外的值記為 `unknown`；儲存格式與 `usage-ledger@1` 不變。測試須涵蓋：帶原因、未帶原因（非串流路徑不變）、集合外的值、用量齊全時帶原因被忽略，以及計價狀態與金額不受原因影響。
- [x] 3.4 `content_filter` 結束於串流路徑改拋 `answer_stream_refused`，節點不提交含已發布片段的回答訊息；需終稿審核的端點以 capability 宣告並於呼叫前降級。（「節點不提交」由 Gateway 拋錯、不回傳訊息來保證，節點接線屬 Task 4。拒答不會被重試層包成 `answer_stream_interrupted`，fallback 也不會改走其他 Provider。）
- [x] 3.5 新增 `answer.stream.degraded{reason}` 封閉 enum 與未知值處理；整包 JSON 降級路徑經大小與 Schema 驗證。（端點收到串流請求卻回合法整包 JSON 時，D9 enum 沒有專屬原因，暫記為 `capability_unsupported`；如需區分，應先修訂 design D9。）

（2026-11-14，CCR implementation_secondary，handoff-apply-task2-8-03-ccr：
- 新增 `openai-chat-stream.ts`。串流能力只宣告於 `qwen` provider（`supportsStreaming`、`supportsStreamUsage`），其他 OpenAI-compatible 端點在呼叫前降級為整段回覆。
- 測試：`openai-chat-stream.test.ts` 18 項，以同一 fixture 測試每個 byte 切點與單 byte chunk；`llm-gateway.answer-stream.test.ts` 11 項；`answer-text-sink.test.ts` 23 項；`ledger.test.ts` 新增 4 項；`runtime-config.test.ts` 新增 11 項。
- 驗證：`cd backend && npm run lint && npm run test && npm run build` 全部通過，301 files，2500 passed，118 skipped。evidence：`task3-backend-*-ccr.txt`。
- 3.1 的端點實測已於 2026-11-15 補做，見 3.1 下方紀錄。）

驗證：`cd backend && npm run lint && npm run test && npm run build`。契約測試以同一組 fixture 切在不同 byte 邊界，涵蓋半個中文字、被拆開的 surrogate（並斷言 `textOffset` 為解碼後 UTF-16 code unit 數而非 UTF-8 byte 數）、半個 JSON、跳脫引號、空框、usage 尾框、缺完成訊號、超限、三種逾時、取消與 writer 失敗；驗證 final message 等於已接受文字且只提交一次。

## 4. chatbot 節點接線與 readiness（design D4、D9）

- [x] 4.1 由 composition root 提供 `ExecutionContext` 與 `RunSequenceAllocator` 建立 sink，接至 LangGraph custom writer；開始生成前配置 `messageId`，終稿沿用。
- [x] 4.2 正文事件以版本化 `model.stream` 發送，帶 `messageId`、`outputKind = "answer_text"`、`textOffset`（依 Task 1.4 結果決定是否等待契約發布）。
- [x] 4.3 新增 readiness 檢查：功能啟用但接線缺失時失敗；功能關閉時記錄 `feature_disabled` 並維持既有回覆。

（2026-11-15，CCR implementation_secondary，handoff-apply-task2-8-03-ccr：
- 開工時發現正式 `chatbot` 沒有 ExecutionContext，也沒有可共用的 allocator。Master 核准比照 `deep_researcher` 接上，決策已先寫入 design D4，再施工。
- 新增 `runtime/answer-stream/answer-stream-wiring.ts`：
  - 提供 process 範圍的 allocator，在 graph 組裝時注入節點。
  - 提供 `prepare()`：依序判定 `feature_disabled`、`envelope_disabled`、`execution_context_missing`、`writer_missing` 四種降級原因，或建立 sink；sink 把每段正文以 `emitEnvelope` 發成 `model.stream` 並交給 custom writer。
  - 提供 readiness 判定。
- 設定：`ANSWER_TEXT_STREAMING_ENABLED` 預設關閉。
- readiness：`/health/readiness` 在功能啟用但 envelope 停用或接線未登記時回 503，設定無法讀取時也回 503。
- `chatbot` 改為 usage attribution → execution context（`PgGraphTaskAdmission`）→ governance 的包裝順序。終稿 `AIMessage.id` 沿用 `messageId`。
- 在 LangGraph 內 writer 一定存在，所以 `writer_missing` 只在 wiring 層測試。
- 測試：`chatbot.context.test.ts` 新增 6 項，涵蓋串流 envelope、三種降級原因、發布後中斷不提交訊息、正式 graph 在缺少可信 context 時拒絕；`answer-stream-wiring.test.ts` 7 項；`answer-stream-readiness.test.ts` 4 項。
- 驗證：`cd backend && npm run lint && npm run test && npm run build` 全部通過，303 files，2517 passed，119 skipped。完整 test 涵蓋深度研究、購物、MCP、數學 graph 的既有測試，沒有回歸。evidence：`task4-backend-*-ccr.txt`。
- 已知：Task 1.2 的 live gate graph（`stream-chat-answer-text-gate/live/custom-gate-graph.ts`）註解寫「與 chatbotGraph 相同包裝」，現已不同。它是閘門 evidence，未修改。）

驗證：`cd backend && npm run lint && npm run test && npm run build`。另回歸深度研究、購物、MCP、數學 graph 的既有測試，確認未選用 sink 者行為不變。

## 5. BFF 防緩衝（design D10）

- [x] 5.1 上游為 SSE 串流時加上 `X-Accel-Buffering: no` 與 `Cache-Control: no-cache, no-transform`；非 SSE 回應 header 不變。
- [x] 5.2 契約測試：上游放行前下游已讀到第一框；慢讀背壓、取消、headers 前後錯誤與 SSE 中斷維持既有行為。`bff/package.json` 已有 `test`（vitest，排除 passthrough 測試）與 `test:node`（`node --test`，含 `stream-passthrough.test` 與 `test/*.test.mjs`）兩個入口；本 Task MUST 沿用既有入口，passthrough 相關測試放入 `test:node` 涵蓋的位置，不得改寫或移除既有 script，也不得引入新的測試框架。

驗證：`cd bff && npm run build && npm run test`。

（2026-11-15，CCR implementation_secondary，handoff-apply-task2-8-03-ccr：
- `stream-passthrough.ts` 新增 `applySseAntiBufferingHeaders`，只依上游媒體型別判斷，不分大小寫，忽略 charset 參數。
- LangGraph proxy 在複製上游 header 之後套用；metrics proxy 不經過 LangGraph SSE，不受影響。
- 測試：
  - `test/sse-anti-buffering.test.mjs` 5 項：SSE header 與「上游暫停時下游已收到第一框」、非 SSE header 不變、headers 前的上游 5xx、client 取消傳遞到上游、串流中斷後維持既有 SSE error frame 且不出現額外正文。
  - `stream-passthrough.test.ts` 新增 1 項媒體型別判斷。慢讀背壓沿用既有的 `honors writable backpressure` 測試。
  - 全部沿用既有 `test:node` 入口，未改 script，也未引入新框架。
- 驗證：`cd bff && npm run build && npm run test` 全部通過，vitest 21 files／224 passed，`test:node` 28/28。evidence：`task5-bff-*-ccr.txt`。
- 未執行：經部署代理（例如 nginx）的實測，由 Task 7.3 處理。）

## 6. 前端正文消費（design D6、D11、D12）

- [ ] 6.1 custom 資料入口 runtime validation 與 ownership 核對，獨立於 `showActivityTimeline`。
- [ ] 6.2 正文 reducer（純函式）：`(threadId, runId, messageId)` 身分、`textOffset` 接合、重複只套一次、`answerDraftGapWaitMs` 有界等待、終稿取代與封住晚到片段。
- [ ] 6.3 正文事件同時進入 `BoundedRuntimeEventBuffer`；活動流程略過 `outputKind = "answer_text"`。
- [ ] 6.4 渲染：穩定 React key、繪製週期合併、貼底跟隨、每幀同一安全 Markdown 渲染器；卸載與終止清理排程。
- [ ] 6.5 依 application profile 的斷線恢復呈現（demo 只提供重新生成）；拒答時同一泡泡收回已顯示片段並改顯示拒答提示；中斷保留片段並標記。中斷、逾時、拒答狀態由錯誤碼經文案目錄產生。

驗證：`cd frontend && npm run lint && npm run test && npm run build`。reducer 測試涵蓋重複、亂序、缺段、終稿先到、取消後晚到、跨通道晚到的非正文事件；回歸深度研究、購物卡、工具失敗與 HITL resume。

## 7. 跨層確定性 E2E 與 live smoke（spec 全部 Requirement）

- [ ] 7.1 跨層 E2E：Provider 第一框後鎖住第二框；斷言首段已顯示、可取消、第二段未出現；讀取泡泡身分後放行第二框並斷言同一泡泡追加；放行完成框後重載核對歷史只有一則回答；斷言本次未記錄降級。
- [ ] 7.2 E2E 補充：兩段正文之間插入另一通道晚到的非正文事件；demo profile 斷線；串流途中拒答（斷言片段被收回、顯示拒答提示，重新載入後歷史不含片段）；開啟時間軸的 agent 不重複顯示正文。
- [ ] 7.3 live smoke：對每個宣告支援的端點，以足夠長的純文字回答記錄 Provider、模型、首段可見、後續片段、usage 與終止證據，並驗證部署代理未緩衝。只有 loading、時間軸或回放動畫不符合放行條件。放行 MUST 同時滿足：
  - 首段可見延遲（送出到瀏覽器顯示第一段正文）在 Task 3.1 回填於 design D8 預設值表的上限內，並記錄實測值。
  - 首段可見之後、完成之前，瀏覽器至少再收到兩段正文更新，且相鄰更新的最大間隔不超過閒置逾時設定。
  - 完成後只保留一則回答，且全文與終稿逐字相同。
  - 每次上游嘗試恰好一筆 usage 紀錄；缺值時帶 `usageMissingReason`。
  - 經部署代理量測的首段抵達時間與直連 BFF 相比，沒有等待整段回覆完成的跡象，並保存兩者的量測紀錄。

驗證：`cd frontend && npm run test:e2e`；live smoke 結果以 evidence 保存。mock 與 E2E 通過不等同 live 驗收。

## 8. 收尾

- [ ] 8.1 執行三套件完整驗證：backend 與 frontend 的 `npm run lint`、`npm run test`、`npm run build`；bff 的 `npm run build`、`npm run test`；frontend 的 `npm run test:e2e`。
- [ ] 8.2 implementation_result 如實列出未執行的驗證、live 限制與規格差異。
- [ ] 8.3 確認 design「後續待辦」FU-1（demo 斷線後重新同步）與 FU-2（多 worker／多 session 事件序號）已列入待辦清單或另立 Change，並在 implementation_result 引用；不得在本 Change 內實作。
