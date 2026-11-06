# Tasks：一般聊天正文串流

> 每個 Task 完成時必須附上實際執行的命令與結果。未執行的驗證必須明確列出，不得勾選。Task 1 為閘門；任一閘門失敗時依 design D4 停止並回報 CCR，不得以替代證據繼續。

## 1. 閘門：固定失敗案例與橋接能力（design D4、D5、D7、D11）

- [ ] 1.1 建立可控制的 Provider fixture：送出合法第一框後等待測試放行，才送第二框與結束框。經真正的 Gateway、LangGraph Server、BFF 與瀏覽器送出一般聊天，記錄目前首段停在哪一層（evidence）。
- [ ] 1.2 以最小 custom writer 驗證 custom 事件能在節點返回前，穿過治理 wrapper 與 usage attribution wrapper 抵達瀏覽器，且既有串流模式不變。不得以節點完成後的 `updates` 作為證據。
- [ ] 1.3 依 lockfile 確認前端 LangGraph SDK 實際版本並改為精確版本；確認 custom 訂閱能力；記錄每個 agent 加入訂閱前後實際請求的 `streamMode`。
- [ ] 1.4 確認 harness-contracts 的 `model.stream` payload schema 能否保留新增欄位；若為 strict，記錄所需的契約版本發布步驟並回報 CCR。（2026-11-03 已確認 `0.1.0-alpha.3` 為 strict，見 `implementation-gate-evidence-01`；路徑依 design D5「選定路徑」。本 Task 於 Task 1.7 的 probe 通過後才可勾選。）
- [ ] 1.5 確認 usage ledger 能承接缺值原因欄位；不能時回報 CCR。
- [ ] 1.6 確認 `RunSequenceAllocator` 在目前部署形態下的作用範圍，結果回填 design「已知限制」KL-1。若發現目前部署已是多 worker／多 session，停止並回報 CCR（多 worker 支援屬後續待辦 FU-2）。
- [ ] 1.7 前置條件：上游 `@gun-ai/harness-contracts` 與 `@gun-ai/harness-kernel` 已依 design D5 發布含三個選用欄位的新精確 alpha 版本，且可從公開 registry 匿名安裝。前置條件未滿足時 MUST 停止並回報 CCR，不得以本地 `file:` 連結、pack、dry-run 或 sibling checkout 代替。滿足後，於同一增量：
  - 將 `backend/package.json` 的兩個套件改為新的精確版本並更新 lockfile；不得使用版本範圍。
  - 以 Task 1.4 相同的 probe 驗證：只有 `delta` 的 payload 通過；帶三個新欄位的正文 payload 通過；未知欄位仍被拒；`textOffset` 為負數、`outputKind` 為未知值時被拒。
  - 驗證 kernel 經 envelope 解析與轉送後三個欄位仍保留。
  - 依 `harness-consumer-integration` 完成 adapt，不新增平行本地定義，`chat-gun-parallel-local-definition` 檢查通過。

驗證：`cd backend && npm run test`；Task 1.7 另需 `cd backend && npm run lint && npm run test && npm run build` 全綠，並保存 registry 安裝來源與 probe 結果；`cd frontend && npm run test:e2e`（fixture 案例）；evidence 存放於 `.agent-runtime/stream-chat-answer-text/` 並以 ArtifactReference 引用。

## 2. Gateway 正文 sink 與重試邊界（design D2、D3）

- [ ] 2.1 新增 `AnswerTextSink`、`AnswerTextAttemptWriter`、`AnswerStreamAttempt` 與 `ChatModelInvokeOptions.answerTextSink`；封存後寫入丟棄並記錄 `answer.stream.late_delta_dropped`。
- [ ] 2.2 sink 與 `responseFormat` 或 `bindTools` 並用時，於呼叫前拋出可分類設定錯誤。
- [ ] 2.3 新增 `isRetryBlockedByPublishedAnswer` 與 `AnswerStreamInterruptedError`（`answer_stream_interrupted`），接入 adapter 重試迴圈、tool argument 修復重送、結構化輸出修復與 Provider fallback 四層；`classifyProviderError` 判定為不可 fallback。
- [ ] 2.4 tracing、metrics、usage attribution 包裝層傳遞 sink 與取消訊號。

驗證：`cd backend && npm run lint && npm run test && npm run build`。測試須涵蓋：發布後四層皆不重試；逾時落敗嘗試的晚到片段被丟棄並計數；不合法組合拋錯；未傳 sink 的既有 caller 行為不變。

## 3. OpenAI-compatible 串流解碼、逾時與計量（design D7、D8、D9）

- [ ] 3.1 新增 `llmStreamFirstChunkTimeoutMs`、`llmStreamIdleTimeoutMs`、`llmStreamTotalDeadlineMs`、`llmStreamMaxPendingBytes` 至 runtime config 並驗證範圍；sink 存在時 fallback 以首段逾時取代 `perProviderTimeoutMs`。依 OQ3 決策，以目標端點實測首段延遲決定各設定與 `answerDraftGapWaitMs` 的預設值與上下限，回填 design「Resolved Questions」的 D8 預設值表，並保存量測 evidence。
- [ ] 3.2 在 OpenAI-compatible adapter 實作串流解碼：增量 UTF-8、SSE 框界線、完成標記、usage 框、推理內容與工具參數分流、surrogate 暫留；逾時經 `AbortSignal` 中止 reader。
- [ ] 3.3 新增 `supportsStreamUsage` capability；支援時送出 `stream_options.include_usage`；每次上游嘗試於 `finally` 恰好計量一次，缺值帶 `usageMissingReason`。
- [ ] 3.4 `content_filter` 結束於串流路徑改拋 `answer_stream_refused`，節點不提交含已發布片段的回答訊息；需終稿審核的端點以 capability 宣告並於呼叫前降級。
- [ ] 3.5 新增 `answer.stream.degraded{reason}` 封閉 enum 與未知值處理；整包 JSON 降級路徑經大小與 Schema 驗證。

驗證：`cd backend && npm run lint && npm run test && npm run build`。契約測試以同一組 fixture 切在不同 byte 邊界，涵蓋半個中文字、被拆開的 surrogate（並斷言 `textOffset` 為解碼後 UTF-16 code unit 數而非 UTF-8 byte 數）、半個 JSON、跳脫引號、空框、usage 尾框、缺完成訊號、超限、三種逾時、取消與 writer 失敗；驗證 final message 等於已接受文字且只提交一次。

## 4. chatbot 節點接線與 readiness（design D4、D9）

- [ ] 4.1 由 composition root 提供 `ExecutionContext` 與 `RunSequenceAllocator` 建立 sink，接至 LangGraph custom writer；開始生成前配置 `messageId`，終稿沿用。
- [ ] 4.2 正文事件以版本化 `model.stream` 發送，帶 `messageId`、`outputKind = "answer_text"`、`textOffset`（依 Task 1.4 結果決定是否等待契約發布）。
- [ ] 4.3 新增 readiness 檢查：功能啟用但接線缺失時失敗；功能關閉時記錄 `feature_disabled` 並維持既有回覆。

驗證：`cd backend && npm run lint && npm run test && npm run build`。另回歸深度研究、購物、MCP、數學 graph 的既有測試，確認未選用 sink 者行為不變。

## 5. BFF 防緩衝（design D10）

- [ ] 5.1 上游為 SSE 串流時加上 `X-Accel-Buffering: no` 與 `Cache-Control: no-cache, no-transform`；非 SSE 回應 header 不變。
- [ ] 5.2 契約測試：上游放行前下游已讀到第一框；慢讀背壓、取消、headers 前後錯誤與 SSE 中斷維持既有行為。`bff/package.json` 已有 `test`（vitest，排除 passthrough 測試）與 `test:node`（`node --test`，含 `stream-passthrough.test` 與 `test/*.test.mjs`）兩個入口；本 Task MUST 沿用既有入口，passthrough 相關測試放入 `test:node` 涵蓋的位置，不得改寫或移除既有 script，也不得引入新的測試框架。

驗證：`cd bff && npm run build && npm run test`。

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
