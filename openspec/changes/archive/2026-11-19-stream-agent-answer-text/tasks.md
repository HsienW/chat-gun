# Tasks：深度研究與購物政策回答的正文串流

> 每個 Task 完成時必須附上實際執行的命令與結果。未執行的驗證必須明確列出，不得勾選。Task 1 為閘門；任一閘門失敗時停止並回報 CCR，不得以替代證據繼續。不得讀取 `.env*`；`npm test` 讀取已提交的 `backend/.env.example` 範本屬允許範圍。

## 1. 閘門：端點能力與既有缺陷確認（design D2、D6）

- [x] 1.1 以真實部署端點（`qwen`）確認 `stream: true` 搭配 `response_format: json_object` 能逐框回傳 `delta.content`，並記錄首段延遲、框數與完成訊號（evidence）。不支援或無法連線時停止並回報 CCR；`supportsStructuredOutputStreaming` 的宣告值依此結果決定，MUST NOT 依模型名稱判斷。
- [x] 1.2 以序列化斷言重現 `synthesizeAnswer` 的 citation guard 改寫（`normalized.content = guarded.answer`）是否進入序列化結果，記錄結果（evidence）。不論結果，後續 Task 3 一律以建構子建立終稿。
- [x] 1.3 確認 `deep_researcher` 與 `shopping_assistant` 的回答節點在真實 Runtime 中可取得 `config.writer` 與可信 ExecutionContext（沿用前一 Change Task 1.2 的閘門方法，不得以節點完成後的 `updates` 為證據）。

驗證：evidence 存放於 `.agent-runtime/stream-agent-answer-text/` 並以 ArtifactReference 引用。

## 2. Gateway 結構化欄位投影（design D2）

- [x] 2.1 新增 `ChatModelInvokeOptions.answerTextProjection` 與相容規則：sink 搭配 `responseFormat` 時須帶 `json_object` 與投影，否則呼叫前拋出 `answer_sink_incompatible_call`；sink 搭配投影但沒有 `responseFormat`、或 `type` 不是 `json_object` 時，同樣於呼叫前拋出 `answer_sink_incompatible_call`；sink 與工具綁定仍一律拒絕；未帶 sink 時忽略投影。測試涵蓋 design D2 組合表的每一列。
- [x] 2.2 新增純函式 `JsonStringFieldProjector`：頂層第一次出現的指定鍵、字串值才投影；跳脫序列完整後解碼；`\uXXXX` 跨 chunk；surrogate pair 配對後發布；結構不合預期時停止並記錄 `answer.stream.projection_stopped`。
- [x] 2.3 OpenAI-compatible 串流路徑在有投影時送出 `response_format` 與 `stream: true`，可見內容經投影器交給 attempt writer；終稿 `content` 為完整 JSON 原文。
- [x] 2.4 新增 capability `supportsStructuredOutputStreaming`（依 Task 1.1 決定宣告值）；未宣告時於呼叫前降級並記錄 `capability_unsupported`。

驗證：`cd backend && npm run lint && npm run test && npm run build`。投影器契約測試以同一 fixture 切在不同 byte 邊界，涵蓋跳脫引號、`\n`、`\uXXXX`、跨 chunk 的 surrogate pair、巢狀同名鍵、重複鍵、非字串值、空字串、`abstained` 在 `answer` 之前與之後；Gateway 測試涵蓋相容規則、降級、發布後不重試、計量與終稿內容。

## 3. 深度研究接線（design D3、D5、D6、D7）

- [x] 3.1 `deep_researcher` 組裝時建立 wiring 並注入，呼叫 `registerAnswerStreamGraph`；`synthesizeAnswer` 研究答案分支於模型呼叫前 `prepare()` 並傳入 sink。
- [x] 3.2 保留 `normalizeAiMessageForStream` 正規化，再以正規化後字串內容（citation guard 後）與 `messageId` 建構新 `AIMessage`，帶入正規化結果的其他欄位；不得於建構後改寫 `id` 或 `content`。
- [x] 3.3 `answer_stream_interrupted`／`answer_stream_refused` 經 `AnswerStreamRunError` 拋出，不落入 `targetedToolFallback` 或 `Research synthesis failed`；其他錯誤沿用既有 fallback。
- [x] 3.4 澄清、天氣、上傳錯誤、targeted tool error 分支不建立 sink。

驗證：`cd backend && npm run lint && npm run test && npm run build`。測試涵蓋：串流 envelope 與終稿 id；citation guard 修改後序列化 `kwargs` 的 `id` 與 `content`；發布後中斷與拒答的錯誤碼；不經模型分支不呼叫 `prepare()`；模型回傳陣列 content 時終稿內容正確；`clarifyInterrupt` resume 後進入研究答案分支會重新 `prepare()` 並正確串流與提交終稿，且 sink／`messageId` 不進入 checkpoint；功能關閉時行為不變；深度研究既有測試全數通過。

## 4. Gun Shop 政策回答接線（design D4、D5、D6、D7）

- [x] 4.1 `PolicyAnswerSynthesizer.synthesize` 新增選用 sink 參數（options 物件，既有呼叫相容）；`LlmPolicyAnswerSynthesizer` 有 sink 時以 `answerTextProjection: { kind: "json_string_field", field: "answer" }` 呼叫。
- [x] 4.2 `shopping_assistant` 組裝時建立 wiring 並注入、登記；`policy_answer` 於合成前 `prepare()`，合成後的 `answered`、`abstained`、`unverified`、`synthesis_failed` 回覆都以同一 `messageId` 建構；為此修改 `reply()` 接受選用 `id`（或新增 `replyWithId`），`lookup_failed`、`no_source_found` 沿用既有 `reply(content)`。
- [x] 4.3 `answer_stream_interrupted`／`answer_stream_refused` 經 `AnswerStreamRunError` 拋出，不被 `synthesis_failed` 吞掉；稽核事件照常記錄；`lookup_failed`、`no_source_found` 不建立 sink。

驗證：`cd backend && npm run lint && npm run test && npm run build`。測試涵蓋：驗證通過時終稿等於投影文字；無法驗證、放棄、解析失敗時以同 id 提交固定回覆；非回答欄位不出現在正文；發布後中斷與拒答錯誤碼；`turnEvidence`、`runtimeEvents`、稽核不變；購物既有測試（含訂單、HITL、冪等）全數通過。

## 5. readiness（design D7）

- [x] 5.1 `ANSWER_STREAM_REQUIRED_GRAPHS` 改為 `chatbot`、`deep_researcher`、`shopping_assistant`；更新 readiness 測試（任一未登記即失敗、全部登記才通過、功能關閉時通過）。

驗證：`cd backend && npm run lint && npm run test && npm run build`。

## 6. 前端驗證（design D8）

- [x] 6.1 確認前端產品程式不需修改；若發現缺口，先回報 CCR 更新 design 與 tasks 再施工。
- [x] 6.2 E2E 補充：深度研究（開啟時間軸）正文逐段顯示、時間軸不含串流片段，且展開後『最終回答』項目顯示防護後的終稿、終稿以不同內容取代草稿；Gun Shop 政策回答逐段顯示、驗證失敗時同一泡泡改顯示固定回覆、重新載入（以 thread 權威狀態核對）只含終稿；兩者發布後中斷與拒答的呈現。

驗證：`cd frontend && npm run lint && npm run test && npm run build && npm run test:e2e`。

## 7. 跨層驗證與 live smoke

- [x] 7.1 真實跨層驗證：以 mock provider 對深度研究與政策回答各執行一次，斷言首段在上游暫停時可見、終稿取代草稿、歷史只有一則回答（沿用前一 Change 的 `cross-layer-run` 方法）。
- [x] 7.2 live smoke：對部署端點各執行一次深度研究與政策回答，記錄首段可見延遲、更新次數、最大間隔、終稿與 usage；放行條件同前一 Change Task 7.3（首段在 D8 上限內、至少兩次後續更新、最大間隔在閒置上限內、只保留一則回答）。
  - 部分驗證（Master 2026-11-19 接受）：深度研究 live 通過（合成開始後約 330 ms 首段、26 次後續更新、最大間隔 185 ms、草稿與終稿同 messageId、只有一則回答、usage 已記錄）；量測經 BFF API，未經前端 UI。政策回答因部署 egress 政策拒絕 `kb_search`（`EGRESS_DENIED`／`PRIVATE_ADDRESS`）於合成前結束，未觸發欄位投影串流，改以 Task 1.1 真實端點實測與 Task 7.1 mock 跨層驗證作證；部署環境 live 驗證列為已知限制。證據：`.agent-runtime/stream-agent-answer-text/evidence/task7-2-live-smoke-ccr-01.json`。

驗證：evidence 存放於 `.agent-runtime/stream-agent-answer-text/`；mock 與 E2E 通過不等同 live 驗收。

## 8. 收尾

- [x] 8.1 三套件完整驗證：backend 與 frontend 的 `npm run lint`、`npm run test`、`npm run build`；bff 的 `npm run build`、`npm run test`；frontend 的 `npm run test:e2e`。
- [x] 8.2 implementation_result 如實列出未執行的驗證、live 限制與規格差異。
