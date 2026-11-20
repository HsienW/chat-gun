# Proposal：深度研究與購物政策回答的正文串流

## Why

### 問題

`stream-chat-answer-text`（2026-11-17 封存）讓一般聊天（`chatbot`）在模型生成期間逐段顯示正文。開關打開後，Gun Chat 已能逐段顯示，但深度研究與 Gun Shop 仍要等整段回答完成才一次出現：

- **深度研究**：規劃、搜尋與驗證完成後，`synthesizeAnswer` 節點才以一次模型呼叫寫出最終答案。這一步的等待時間最長，卻沒有接上正文 sink。
- **Gun Shop 政策回答**：`policy_answer` 節點以 `json_object` 結構化輸出產生 `{ "abstained", "answer" }`，再驗證引用，無法驗證時改回固定回覆。上一個 Change 的 design D2 規定 sink 不得與 `responseFormat` 並用，所以這條路徑目前不能串流。
- Gun Shop 的商品與訂單回覆是模板文字加商品卡片，不經過模型自由撰寫，原本就是一次出現，不在本 Change 範圍。

## What Changes

- **Gateway 結構化欄位投影**：新增一種選用的 sink 模式。呼叫端以 `json_object` 結構化輸出時，可指定一個頂層字串欄位（本 Change 為 `answer`）。Gateway 以串流解碼回應，只把該欄位解碼後的文字發布為正文，完整 JSON 原文仍作為終稿內容交給既有解析與驗證。與工具綁定並用仍不允許。
- **深度研究接線**：`synthesizeAnswer` 的研究答案路徑接上正文 sink。citation guard 處理後的內容以相同訊息身分提交為終稿，由前端取代草稿。天氣、澄清、上傳錯誤等不經模型的分支不串流。
- **Gun Shop 政策回答接線**：`policy_answer` 經欄位投影串流 `answer`。驗證通過時，終稿內容與草稿相同；放棄回答、無法驗證或合成失敗時，節點以相同訊息身分提交既有的固定回覆，取代已顯示的草稿（Master 決策「先顯示再收回」）。
- **錯誤語意一致**：兩個 graph 在正文發布後的中斷與拒答，沿用 `chatbot` 的 `AnswerStreamRunError` 錯誤碼通道，不被節點既有的 fallback 吞掉；只有領域結果（citation guard 修改、政策回答放棄或無法驗證）由終稿取代草稿。
- **readiness**：功能啟用時，readiness 要求 `chatbot`、`deep_researcher`、`shopping_assistant` 三者皆已接線。
- **終稿建構**：所有接線節點以建構子建立帶訊息身分的終稿，不得於建構後改寫 `id` 或 `content`（避免序列化遺失，見 design D6）。

## Capabilities

### New Capabilities

無新的 capability spec。

### Modified Capabilities

- `chat-answer-text-streaming`：新增深度研究最終答案串流、購物政策回答欄位投影串流、領域終稿取代草稿，以及結構化欄位投影的解碼要求。

## 範圍

### 目標

- 深度研究的研究答案、Gun Shop 的政策回答，在功能啟用且端點支援時逐段顯示。
- 領域後處理（citation guard、引用驗證）的結果永遠以權威終稿呈現，草稿不進入歷史。
- 正文發布後的中斷與拒答，與一般聊天有相同的錯誤碼與呈現。

### 非目標

- Gun Shop 商品與訂單回覆、意圖路由、知識查詢請求的串流（不是模型自由撰寫的正文，或為工具呼叫）。
- 深度研究的規劃、查詢產生、反思等中間步驟串流。
- 在串流期間逐段執行引用驗證或 citation guard（Master 決策為終稿取代）。
- 數學、MCP 等其他 graph。
- 各 graph 獨立的功能開關；沿用單一開關 `ANSWER_TEXT_STREAMING_ENABLED`。
- 前一個 Change 的後續待辦（FU-1、FU-2、部署代理量測、threadId 持久化等）。

## 受影響套件與能力域

| 套件 | 影響 |
|---|---|
| `backend` | Gateway 結構化欄位投影與相容規則、`deep_researcher` 與 `shopping_assistant` 節點接線、終稿建構、錯誤碼傳遞、readiness 必要接線清單。 |
| `frontend` | 預期不需修改產品程式；以 E2E 驗證兩個 agent 的串流、終稿取代草稿與時間軸不重複顯示。如驗證發現缺口，依 design 處理。 |
| `bff` | 不修改。 |

能力域：Model Provider、Structured Output、LangGraph Node、Runtime Event、Frontend Rendering。

## 規格決策（Master 於 2026-11-19 決定）

1. Gun Shop 政策回答：先顯示再收回。從 JSON 逐段取出 `answer` 欄位顯示；放棄回答、無法驗證或合成失敗時，以終稿取代草稿。
2. 深度研究 citation guard：先串流，完成後以防護過的終稿取代草稿。

## 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 使用者短暫看到之後被收回或修改的內容 | 未經驗證的政策說法或之後被刪除的引用短暫可見 | Master 已接受；終稿永遠為權威內容，草稿不寫入歷史；文案與 E2E 覆蓋取代情境。 |
| 端點不支援結構化輸出的串流 | Gun Shop 無法串流 | Task 1 以真實端點確認；不支援時於呼叫前降級為整段回覆並記錄降級原因。 |
| JSON 欄位投影解碼錯誤 | 顯示跳脫字元或錯字 | 以位元組邊界、跳脫序列、surrogate、重複鍵、非字串值等 fixture 做契約測試。 |
| citation guard 修改內容未進入 thread state（既有缺陷嫌疑） | 歷史保留被防護掉的引用 | Task 1 先重現確認；本 Change 以建構子建立終稿修正。 |
| 開關一次啟用三個 graph | 回滾範圍較大 | readiness 要求三者皆接線；關閉開關即回到整段回覆。 |

## 回滾

關閉 `ANSWER_TEXT_STREAMING_ENABLED` 後，三個 graph 的新 Run 都回到整段回覆。欄位投影為選用參數，未傳入時 Gateway 行為不變。
