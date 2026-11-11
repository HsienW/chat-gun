# Proposal：一般聊天正文串流

> 規劃基準：`feat/4.6.5-feat/lane-knowledge-retrieval` @ `7913c75`。來源為 Codex 技術方案草稿 `chat-response-streaming-plan.md`，經 CCR 審查修訂後納入本 Change（2 個 Blocker、7 個 Major、7 個 Minor 已併入 design）。

## Why

### 問題

Gun Chat 關閉深度研究時走 `chatbot` graph。節點等待模型呼叫整段完成，才回傳一則 `AIMessage`。使用者在整段回答生成期間只看到 loading，首段可見正文的延遲等於整段生成時間。

逐層確認後，缺口不只一處：

- **Gateway**：所有 Provider adapter 都以完整回應讀取，`supportsStreaming` 一律為 `false`，usage 也從完整回應取得。
- **重試邊界**：重試分散在 adapter 內部重試、tool argument 修復重送、結構化輸出修復與 Provider fallback 四層。一旦開始發布正文，這四層都沒有「已發布就停止透明重試」的共同依據；逾時落敗的嘗試也可能在中止前繼續寫入。
- **逾時語意**：fallback 的逾時是整次呼叫的總時限，直接沿用會在長回答中途切斷。
- **事件順序**：前端以整個 Run 的 `sequence` 做 bounded reordering，遇缺口會等待。正文若經過這道閘門，會被其他通道晚到的事件卡住。
- **前端入口**：正文只取自 `thread.messages`；版本化 `model.stream` 的 `delta` 只進入活動流程，且一般聊天關閉時間軸時整段處理會提前返回。
- **恢復語意**：demo profile 強制斷線即取消 Run，「重新同步結果」在 demo 下不可能取得終稿。

只改前端或只切換 capability 都無法達成目標。

## What Changes

- Gateway 新增選用的正文輸出契約：呼叫端傳入 sink，adapter 在模型生成期間發布可公開的正文片段，最終仍回傳完整訊息。
- 所有重試層共用「已發布即停止透明重試」判斷；發布後的失敗一律成為不可重試、不可 fallback 的可分類錯誤。
- 新增串流專用的首段、閒置與總時限設定；串流 usage 依 capability 請求並在每次上游嘗試恰好計量一次。
- `chatbot` 的回答節點接入 sink，經 LangGraph custom 串流傳遞版本化 `model.stream` 事件；`model.stream` payload 以選用欄位擴充正文身分與偏移。
- 前端新增獨立的正文消費路徑：正文依訊息身分與偏移套用，不受整個 Run 的序號閘門阻擋；活動流程略過正文事件；最終訊息以相同 ID 取代草稿。
- BFF 的 SSE passthrough 明確宣告防緩衝 header。
- 依 application profile 定義斷線恢復；新增串流途中拒答的錯誤分類與呈現。
- 新增降級指標與 readiness 檢查，確保功能啟用時不會靜默退回整段回覆。

## Capabilities

### New Capabilities

- `chat-answer-text-streaming`：一般聊天在模型生成期間逐段顯示正文，並在完成、失敗、逾時、取消、斷線與拒答時維持單一、正確的回答。

### Modified Capabilities

- `runtime-event-contract`：前端 bounded reordering 不再作為正文事件的放行閘門；`model.stream` payload 新增選用的正文身分欄位。
- `bff-stream-proxy`：SSE passthrough 新增防緩衝 header 要求。

## 範圍

### 目標

1. 一般聊天（`chatbot` graph）在一個實際部署且已驗證的 OpenAI-compatible 端點上，首段正文於生成完成前顯示。
2. 同一回答在同一泡泡持續更新；完成並重新載入後歷史只有一則回答。
3. 失敗、逾時、取消、斷線、拒答與降級各有明確且可分辨的結果。
4. 正文發布後不發生透明重試、Provider 切換或重複回答。

### 非目標

- 深度研究、購物、MCP、數學等其他 graph 的回答串流；本 Change 只預留 sink 擴充點。
- 結構化輸出與工具參數的增量解碼（維持既有整段路徑）。
- CCR Anthropic Messages adapter 的串流解碼（可於後續 Change 通過同一套契約測試後宣告支援）。
- 調整 demo profile 的 `on_disconnect` 或 `stream_resumable` admission 政策；demo 斷線後重新同步列為後續待辦 FU-1。
- 多 worker／多 session 部署下的事件序號協調；列為後續待辦 FU-2，本 Change 以單 worker 部署為已知限制。
- 暫時正文跨重新整理重播。

## 受影響套件與能力域

| 套件 | 影響 |
|---|---|
| `backend` | Gateway 正文 sink 契約、OpenAI-compatible 串流解碼、四層重試邊界、串流逾時設定、usage 計量、`chatbot` 節點接線、readiness 檢查、降級指標。 |
| `bff` | SSE passthrough 防緩衝 header 與契約測試。 |
| `frontend` | custom 事件消費入口、正文 reducer、活動流程略過正文、終稿對帳、profile 恢復呈現、錯誤碼文案、SDK 精確版本鎖定。 |
| 外部契約 | `@gun-ai/harness-contracts` 的 `model.stream` payload schema 已確認為 strict，需由上游 `gun-harness` 擴充選用欄位並發布新版本，`@gun-ai/harness-kernel` 同步保留欄位；chat-gun 只承接已發布版本（design D5、Task 1.7）。 |

能力域：Model Provider、LangGraph Node、Runtime Event、BFF 串流代理、Frontend Stream Parser 與 Rendering。

## 規格決策（Master 於 2026-11-03 決定）

詳見 design「Resolved Questions」：

1. 串流途中拒答：收回草稿，改顯示拒答提示；片段不寫入歷史。
2. demo profile 斷線：只提供重新生成；重新同步列為後續待辦 FU-1。
3. 逾時與緩衝預設值：Task 3 依目標端點實測首段延遲決定並回填 design，作為 Task 7.3 放行上限。
4. 多 worker 序號範圍：由 Task 1.6 確認；目前為單 worker 部署，記錄為已知限制 KL-1；多 worker／多 session 支援列為後續待辦 FU-2。

## 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| custom 事件無法在節點返回前穿過治理 wrapper 與 SDK | 核心目標無法達成 | 第一個 Task 即以真實 Runtime fixture 驗證；失敗則依 design D4 停止並回報，不以 `updates` 代替。 |
| 正文發布後重試或 fallback | 重複或混雜的回答、重複計費 | 四層共用判斷與 attempt 封存；契約測試逐層覆蓋。 |
| 正文被 Run 序號閘門卡住 | 首段無法即時顯示 | 正文以 `(messageId, textOffset)` 為唯一順序依據；E2E 插入跨通道晚到事件驗證。 |
| 契約 schema 為 strict | 新欄位被拒 | design D5 閘門；必要時先協調契約版本發布，消費端先部署。 |
| 功能啟用但接線缺失而靜默降級 | 測試通過但實際未串流 | readiness 檢查失敗、降級指標、E2E 斷言未降級。 |
| 串流途中拒答 | 使用者已看過的內容無法收回 | 獨立錯誤分類；需終稿審核的端點在呼叫前降級；依 Master 決策收回草稿、片段不寫入歷史（使用者已看過的事實無法消除）。 |
| SDK 版本為範圍宣告 | 行為隨安裝漂移 | 改為精確版本並記錄各 agent `streamMode`。 |

## 回滾

功能開關關閉後，新 Run 回到整段回覆；進行中的 Run 維持開始時的模式；已保存的訊息由原路徑讀取。新增的 payload 欄位為選用，舊消費端不受影響。BFF header 與前端略過正文的變更向後相容，可保留。
