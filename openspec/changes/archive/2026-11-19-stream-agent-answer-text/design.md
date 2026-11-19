# Design：深度研究與購物政策回答的正文串流

## Context

`stream-chat-answer-text` 已建立完整的正文串流路徑：Gateway 正文 sink 與發布後禁止重試（D2、D3）、OpenAI-compatible SSE 解碼與逾時（D7、D8）、`answer-stream-wiring` 以可信 ExecutionContext 與 process 範圍 allocator 發布版本化 `model.stream` 事件（D4）、前端草稿 reducer 以 `(messageId, textOffset)` 接合並由同 id 終稿取代（D6、D11）、錯誤碼經 ErrorEnvelope 傳遞（D12）。本 Change 只把這條路徑接到兩個新的回答節點，並為結構化輸出新增一種 sink 模式。

研究結果：

| Graph | 最終答案節點 | 模型呼叫形態 | 後處理 |
|---|---|---|---|
| `deep_researcher` | `synthesizeAnswer`（研究答案分支） | `createChatModel({ purpose: "research" })`，無 `responseFormat`、無工具 | `normalizeAiMessageForStream`；citation guard 啟用時以 `guardCitations` 刪除無效引用標記與 URL |
| `shopping_assistant` | `policy_answer` | `LlmPolicyAnswerSynthesizer`，`responseFormat: json_object`（端點支援時），輸出 `{ "abstained": boolean, "answer": string }` | `parsePolicyAnswer` 解析、`verifyAnswerCitations` 驗證；放棄、無法驗證、合成失敗改回固定回覆 `REPLIES.*` |

兩個 graph 都已包裝 `instrumentGraphWithExecutionContext`，可取得可信 ExecutionContext。

## Goals / Non-Goals

見 proposal「範圍」。

## Decisions

### D1：只接最終答案節點

| 方案 | 結論 |
|---|---|
| A. 只接 `synthesizeAnswer` 研究答案分支與 `policy_answer` 的合成呼叫 | 採用 |
| B. 連同深度研究的規劃、查詢產生、反思一起串流 | 不採用：中間步驟為結構化輸出，內容不是給使用者的正文，且已由活動時間軸呈現進度。 |
| C. Gun Shop 商品與訂單回覆也串流 | 不採用：回覆為模板文字加卡片，不經模型自由撰寫；知識查詢與訂單請求為工具呼叫，與 sink 不相容。 |

`synthesizeAnswer` 的上傳錯誤、澄清、天氣、targeted tool error 分支不經模型，不建立 sink。`policy_answer` 在合成前結束的分支（`lookup_failed`、`no_source_found`）同樣不建立 sink。

### D2：Gateway 結構化欄位投影

`ChatModelInvokeOptions` 新增選用欄位：

```ts
answerTextProjection?: { kind: "json_string_field"; field: string };
```

- **相容規則（取代前一 Change D2 對 `responseFormat` 的禁止）**：`answerTextSink` 搭配 `responseFormat` 時，MUST 同時提供 `answerTextProjection`，且 `responseFormat.type` MUST 為 `json_object`；否則於呼叫前拋出 `answer_sink_incompatible_call`。反向亦同：`answerTextSink` 搭配 `answerTextProjection` 時，`responseFormat` MUST 存在且 `type` 為 `json_object`，否則於呼叫前拋出 `answer_sink_incompatible_call`（不得忽略投影或靜默降級）。`answerTextSink` 與工具綁定並用仍一律拒絕。未提供 sink 時忽略 projection。完整組合表：

| sink | responseFormat | projection | 工具 | 結果 |
| --- | --- | --- | --- | --- |
| 無 | 任意 | 任意 | 任意 | 既有行為，忽略 projection |
| 有 | 無 | 無 | 無 | 前一 Change 的純文字串流 |
| 有 | `json_object` | 有 | 無 | 欄位投影串流 |
| 有 | 有（任何 type） | 無 | — | `answer_sink_incompatible_call` |
| 有 | 無，或 type 不是 `json_object` | 有 | — | `answer_sink_incompatible_call` |
| 有 | 任意 | 任意 | 有 | `answer_sink_incompatible_call` |
- **能力**：新增 capability `supportsStructuredOutputStreaming`。端點未宣告時，帶 projection 的 sink 呼叫於呼叫前降級為整段回覆，記錄 `answer.stream.degraded{reason: "capability_unsupported"}`。宣告值由 Task 1 以真實端點確認後決定，MUST NOT 依模型名稱判斷。
- **解碼**：串流框解碼沿用前一 Change D7。可見 `delta.content` 依序送入 `JsonStringFieldProjector`，投影器只把指定欄位字串值的**解碼後文字**交給 attempt writer；`textOffset` 以投影後文字的 UTF-16 code unit 計算。
- **投影器規則**：
  - 只投影頂層物件中第一次出現的指定鍵；巢狀物件中的同名鍵、第二次出現的同名鍵一律忽略。
  - 值不是字串時不發布任何文字。
  - 跳脫序列 `\" \\ \/ \b \f \n \r \t \uXXXX` 於完整後才解碼；`\uXXXX` 的四個十六進位字元可跨 chunk；`😀` 這類 surrogate pair 必須配對後才發布，單獨的高位 surrogate 暫留到下一段。
  - JSON 結構不合預期時停止投影並記錄 `answer.stream.projection_stopped`，MUST NOT 拋錯或發布非字串內容；結構是否合法由呼叫端既有的解析與驗證決定。
- **終稿內容**：回傳的 `AIMessage.content` 為完整 JSON 原文（與整段路徑相同），呼叫端既有的 `parsePolicyAnswer` 不變。
- **重試、逾時、計量**：沿用前一 Change D3、D8 與 Task 3.3；發布後禁止透明重試以「已發布投影文字」為準。

替代方案：要求模型先輸出自由文字再另外輸出 JSON（不採用：改變既有回答契約與驗證流程，Master 決策為保留 JSON 並投影欄位）。

### D3：深度研究接線

- `synthesizeAnswer` 研究答案分支於模型呼叫前以 `answer-stream-wiring` 的 `prepare()` 取得 sink 與 `messageId`，以 `answerTextSink` 傳入 `invoke`。
- 終稿：保留既有 `normalizeAiMessageForStream(response)` 正規化步驟（處理陣列 content 與 functionCall block），再以正規化後的字串內容（citation guard 啟用時為防護後內容）與 `messageId` 建構新的 `AIMessage`，並帶入正規化結果的 `name`、`additional_kwargs`、`response_metadata`、`usage_metadata` 等欄位（比照 `chatbot.ts` 的 `withMessageId`）。MUST NOT 於建構後改寫 `content` 或 `id`（D6）。
- HITL：`clarifyInterrupt` resume 後進入 `synthesizeAnswer` 時，每次執行重新 `prepare()` 取得新的 `messageId`；sink 與 `messageId` 不寫入 State 或 checkpoint。
- 錯誤：模型呼叫拋出的錯誤先經 `toAnswerStreamRunError`；屬於 `answer_stream_interrupted` 或 `answer_stream_refused` 時直接拋出帶錯誤碼的 `AnswerStreamRunError`，MUST NOT 落入既有的 `targetedToolFallback` 或 `Research synthesis failed` 回覆。其他錯誤（必定發生在發布前，因發布後的錯誤已由 Gateway 包成中斷）沿用既有 fallback。
- 時間軸：`deep_researcher` 開啟活動時間軸；正文事件不進入活動 buffer、活動流程略過正文（前一 Change D11），不需修改。

### D4：Gun Shop 政策回答接線

- `PolicyAnswerSynthesizer.synthesize` 新增選用的 `answerTextSink` 參數（以 options 物件傳遞，保持既有呼叫相容）。`LlmPolicyAnswerSynthesizer` 有 sink 時以 `answerTextProjection: { kind: "json_string_field", field: "answer" }` 呼叫模型。
- `policy_answer` 節點於合成前以 `prepare()` 取得 sink 與 `messageId`。合成之後的所有回覆（`answered`、`abstained`、`unverified`、`synthesis_failed`）都以同一個 `messageId` 建構，使前端以終稿取代草稿。既有 `reply(content)` helper 只設 content，須新增選用 `id` 參數（或新增 `replyWithId(id, content)`），於建構時帶入；`lookup_failed`、`no_source_found` 不建立 sink，沿用既有 `reply(content)`：
  - 驗證通過：終稿內容即 `answer`，與草稿相同。
  - 放棄回答、無法驗證、解析失敗：終稿為既有固定回覆，取代已顯示的草稿（Master 決策「先顯示再收回」）。
- 錯誤：同 D3，`answer_stream_interrupted`／`answer_stream_refused` 經 `AnswerStreamRunError` 拋出，不被 `synthesis_failed` 的 catch 吞掉；稽核事件照常記錄。
- `turnEvidence`、`runtimeEvents`、稽核內容不變。

### D5：領域終稿取代草稿與錯誤碼的分工

| 情況 | 處理 | 使用者結果 |
|---|---|---|
| 正文發布後連線中斷、逾時、writer 失敗 | `AnswerStreamRunError(answer_stream_interrupted)` | 保留片段並標記中斷或逾時（前一 Change D12） |
| 正文發布後內容過濾拒答 | `AnswerStreamRunError(answer_stream_refused)` | 收回片段、顯示拒答提示 |
| citation guard 修改、政策回答放棄、無法驗證、解析失敗 | 以同 `messageId` 提交權威終稿 | 草稿被終稿內容取代，不顯示中斷或拒答提示 |

前端已依 id 以終稿取代草稿（`selectVisibleDrafts`），不需新增狀態或文案。

### D6：終稿建構與序列化

LangChain 訊息依建構時的欄位序列化；於建構後改寫 `id` 或 `content` 不會進入 thread state（前一 Change Task 7 已發現 `id` 案例）。`synthesizeAnswer` 目前以 `normalized.content = guarded.answer` 改寫 citation guard 結果，**疑似**同樣不會進入 thread state。Task 1 先以序列化斷言重現；不論結果，本 Change 一律以建構子建立終稿，並以序列化後的 `kwargs` 斷言 `id` 與 `content`。

### D7：接線登記與 readiness

- `deep_researcher`、`shopping_assistant` 於 graph 組裝時以 `createAnswerStreamWiring({ sequenceAllocator: answerStreamSequenceAllocator })` 建立 wiring 並注入節點，並呼叫 `registerAnswerStreamGraph`。節點內 MUST NOT 自建 allocator。
- `ANSWER_STREAM_REQUIRED_GRAPHS` 改為 `chatbot`、`deep_researcher`、`shopping_assistant`；功能啟用而任一未登記時 readiness 失敗。
- 沿用單一開關 `ANSWER_TEXT_STREAMING_ENABLED`。

### D8：前端

預期不需修改產品程式：custom 事件對所有 agent 訂閱、草稿依 id 由終稿取代、時間軸 agent 不重複顯示正文，都已在前一 Change 實作並以 E2E 驗證。本 Change 以 E2E 補上兩個 agent 的情境；驗證發現缺口時依本 design 處理並先更新 tasks。

深度研究時間軸的「最終回答」項目來自 synthesize_answer 節點更新的既有轉接，於本 Change 之前即顯示終稿全文；本 Change 不修改此行為（Master 2026-11-19 決策），只要求串流片段不進時間軸、該項目顯示防護後終稿。

## 資料流

```text
deep_researcher.synthesizeAnswer / shopping_assistant.policy_answer
  → answer-stream-wiring.prepare()  ── ExecutionContext + allocator → sink(messageId)
  → llmGateway.invoke(prompt, { answerTextSink [, answerTextProjection] })
      → SSE 解碼 → (投影器) → attempt writer → model.stream(answer_text) → custom writer → BFF → 瀏覽器草稿
  → 節點後處理（citation guard／解析與引用驗證）
  → new AIMessage({ id: messageId, content: 權威內容 }) → thread state → 瀏覽器以 id 取代草稿
```

## 發布與回滾

1. 前端已能處理三個 agent 的正文事件，無需先行部署。
2. 部署 backend 後，以 `ANSWER_TEXT_STREAMING_ENABLED` 一次啟用；關閉即回到整段回覆。

## 安全

- 投影器只發布指定字串欄位，`abstained` 等其他欄位與 JSON 結構不會成為正文。
- 草稿與終稿都經既有安全 Markdown 渲染器；終稿為權威內容，草稿不進入歷史與下一輪輸入。
- 錯誤 envelope 只帶錯誤碼，不帶 Provider 訊息或正文（前一 Change D12）。

## Risks / Trade-offs

見 proposal「風險」。額外取捨：政策回答與研究答案可能先顯示之後被取代的內容，Master 已接受；E2E 斷言取代後歷史只含終稿。

## Resolved Questions（Master 於 2026-11-19 決定）

| # | 問題 | 決策 | 落地位置 |
|---|---|---|---|
| Q1 | Gun Shop 政策回答如何串流 | 先顯示再收回：投影 `answer` 欄位，放棄、無法驗證、失敗時以終稿取代 | D2、D4、D5；Task 2、4 |
| Q2 | 深度研究 citation guard 的時序 | 先串流，完成後以防護過的終稿取代草稿 | D3、D5、D6；Task 3 |

### 已知限制

- 沿用前一 Change 的 KL-1（單一 process 序號範圍）與部署代理未量測。
- 政策回答與研究答案的草稿可能包含之後被收回或刪除的內容，屬 Master 接受的取捨。
