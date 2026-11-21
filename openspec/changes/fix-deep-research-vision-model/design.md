## Context

目前資料流（深度研究開啟、附加圖片）：

```text
frontend handleSubmit
  → human message content = [text, image_url(dataUrl, metadata)...]
  → submit { messages, reasoning_model: <模型選單值，預設 qwen-plus>, ... }
→ bff validateUploadPayload（數量／大小／MIME，不分 graph）→ 原樣 proxy
→ backend deep_researcher
  validate_uploads → build_context_pack → analyze_images → plan_research → ... → synthesize_answer
```

`analyze_images` 現況：

| 項目 | 現況 | 問題 |
| --- | --- | --- |
| 模型 | `createChatModel({ purpose: "vision", model: state.reasoning_model })` | 呼叫端指定優先，`QWEN_VISION_MODEL` 與 `qwen3.5-flash` 被模型選單值覆蓋 |
| 能力檢查 | `supportsVision` 只依 purpose 宣告 | 純文字模型也通過 |
| 成功 | 回應文字寫入 `imageObservations` | — |
| 失敗 | ErrorEnvelope 序列化字串寫入 `imageObservations` | planner／synthesis 把錯誤當成圖片證據 |
| 取消 | 與失敗同一個 catch | 取消被轉成「觀察結果」，沒有向上傳遞 |
| 前端 | Timeline 沒有 `analyze_images` 節點對應 | 使用者看不到看圖步驟與模型 |

相關既有規格：

- `backend-model-runtime` Vision Model Routing：看圖 MUST 使用 Qwen vision 模型；不支援時 MUST 回結構化錯誤或明確降級，MUST NOT 靜默成功。
- `generation-model-profile`：解析優先序為呼叫端指定 → purpose 專屬設定 → legacy → 預設模型。本 Change 不改此優先序，只規定圖片辨識步驟不得把使用者選擇當成呼叫端指定。
- `frontend-model-selection`：深度研究 MUST 以 `reasoning_model` 送出所選模型。本 Change 不改。
- `frontend-chat` Runtime event extraction：node adapter fallback MUST 產生既有 known runtime event shapes。

## Goals / Non-Goals

見 proposal。

## Decisions

### D1：圖片辨識步驟不傳呼叫端模型

`analyze_images` 建立 vision 模型時 MUST NOT 傳入 `reasoning_model`，讓 Gateway 走既有 vision 解析順序：`QWEN_VISION_MODEL` → legacy（`DEFAULT_MODEL`）→ 預設生成模型常數（`qwen3.5-flash`）。

**理由**：使用者選單的語意是「研究推理用的模型」，不是「看圖用的模型」；vision 是部署設定的責任。不需新增任何依模型名稱的判斷。

**替代方案**：

| 方案 | 不採用原因 |
| --- | --- |
| B. 在 Gateway 建立模型能力清單，選到不支援 vision 的模型就 fail fast 或改用 vision 模型 | 需要新的封閉清單與未知模型處理，範圍大；使用者已選 A。可作為後續強化。 |
| C. 修改 frontend 模型選單，加入 `qwen3.5-flash` 或移除 `reasoning_model` | 跨套件並牽動 `frontend-model-selection` 規格；本 Change 非目標。 |
| D. 只在 vision purpose 時讓 Gateway 忽略呼叫端模型 | 讓 Gateway 對某一 purpose 有隱藏的特殊規則，違反 `generation-model-profile` 的單一優先序；在呼叫端修正更清楚。 |

### D2：圖片辨識結果結構化並帶出實際模型 id

新增 Graph State 欄位（名稱由實作決定，以下稱 `imageRecognition`），只含可序列化資料：

```ts
type ImageRecognitionResult =
  | { status: "succeeded"; provider: string; model: string; imageCount: number }
  | { status: "failed"; provider: string; model: string; imageCount: number; error: SerializedErrorEnvelope };
```

- 沒有圖片時不寫入（維持 `undefined`），planner 與 Timeline 都不顯示圖片辨識項目。
- `provider` 與 `model` MUST 來自 Gateway 依 vision 用途實際解析的值。實作 MUST 使用已匯出的 `enabledChatModels([{ purpose: "vision" }])`（內部即呼叫 `resolveProviderModel`，回傳 `{ provider, model, callKind }`）取得；且取得解析值與建立 vision 模型時 MUST 使用相同的 purpose 與相同的「不傳呼叫端模型」條件，確保顯示的模型等於實際送出的模型。不得把私有的 `resolveProviderModel` 改為匯出，也不得在 agent 內重新拼湊或寫死模型名稱。
- 每個新 turn 開始時（`validate_uploads` 的 reset）MUST 清空，避免上一輪結果殘留。
- 舊 checkpoint 沒有此欄位時視為 `undefined`。
- 成功時 `imageObservations` 照舊寫入模型回應文字。

### D3：失敗、逾時與取消語意

| 情境 | 行為 |
| --- | --- |
| provider 錯誤、能力不支援、回應無法解析 | `imageRecognition.status = "failed"`，附 ErrorEnvelope（stage `image_recognition`）；`imageObservations` MUST 保持空陣列 |
| 逾時（Gateway timeout） | 同 failed，ErrorEnvelope 保留逾時錯誤碼 |
| 取消（`config.signal` aborted 或 AbortError） | MUST 重新拋出，不寫入 failed，不繼續 planner |
| 模型回空字串 | 視為 failed（避免把空觀察當成成功） |

planner 與 synthesis 讀取圖片證據時：

- `succeeded` → 沿用現有「Image recognition observations」。
- `failed` → 以明確文字告知模型「使用者上傳了 N 張圖片，但圖片辨識失敗，沒有任何圖片內容可用；不得猜測圖片內容，回答時必須告知使用者圖片未能分析」。這段文字是固定的系統政策文字，不含錯誤細節或 API 內容。
- `undefined` → 沿用「No image attachments were provided.」。

Retry：本 Change 不新增 retry；Gateway 既有的 provider 重試照舊。

### D4：frontend 以 node adapter 顯示圖片辨識

- 在 runtime event node key 新增 `analyze_images`，adapter 讀取節點更新中的 `imageRecognition`：
  - `succeeded` → 產生既有 `agent.tool.success` 形狀的活動項目，顯示「圖片辨識完成（模型：{model}）」。
  - `failed` → 產生既有 `agent.tool.error` 形狀，顯示「圖片辨識失敗（模型：{model}）」，錯誤內容只顯示安全的使用者訊息，不顯示原始 provider 回應。
  - 欄位缺少或格式不符 → 依既有 malformed 規則略過，不得崩潰。
- `{model}` MUST 取自 backend 回傳值；frontend MUST NOT 寫死 `qwen3.5-flash` 或任何模型名稱。在目前部署設定下，畫面會顯示 `qwen3.5-flash`。
- 既有處理流程對 `agent.tool.success` 固定顯示「工具完成：{toolName}」，`RUNTIME_EVENT_LABELS.toolSuccess` 只接受 `toolName`。因此 MUST 擴充 runtime event 處理（處理成活動項目的那一步）與 runtime event labels，讓圖片辨識的活動項目改用專屬文案（新增 `imageRecognitionSucceeded(model)`、`imageRecognitionFailed(model)` 之類的 label），且不改變其他工具既有的「工具完成／工具錯誤」文案。辨識方式 MUST 依結構化欄位（例如 adapter 產生事件時附帶的專屬 toolName 常數），不得依顯示文字判斷。
- 失敗結果中的 `error`（序列化的 ErrorEnvelope 字串）只供 backend State 記錄與排錯。frontend adapter MUST NOT 解析、顯示或轉傳此字串；產生 `agent.tool.error` 時 `error` 欄位 MUST 使用 runtime event labels 中的固定安全訊息（例如「圖片無法辨識，回答不會使用圖片內容」）。
- 文案集中在既有 runtime event labels，不新增 event type，不改 BFF。

### 各套件變更

- **frontend**：runtime event node keys、adapter rule、labels；對應單元測試。
- **bff**：無。
- **backend**：`deep_researcher` 圖片辨識節點、State 欄位、planner／synthesis 圖片證據組裝；Gateway 對外提供依用途解析的 provider／model（若現有匯出不足）。

## 安全與權限

- 不涉及 Tool 或 MCP 權限。
- 畫面只顯示 provider 名稱與模型 id；MUST NOT 顯示 endpoint、API Key、Authorization header 或 provider 原始錯誤全文。
- 圖片內容與 dataUrl 不得寫入 ErrorEnvelope 或 Timeline。

## Risks / Trade-offs

- 使用者選擇的模型不影響看圖：以 Timeline 顯示實際模型降低誤解。
- `qwen-plus` 收圖行為未 live 驗證：修正後不再把圖片送給選單模型，因此結果不依賴該行為；live smoke 列為選做並如實標示。
- planner 與 synthesis 仍使用 `reasoning_model`（非目標），因此深度研究其他步驟依舊不是 `qwen3.5-flash`；記錄為後續建議。

## Migration Plan

無資料遷移。部署後新 run 生效；進行中的 run 不受影響。

## Open Questions

- 是否另在附件區顯示靜態提示（例如「圖片會由系統設定的 vision 模型辨識」）？本 Change 預設不做，只在 Timeline 顯示實際模型。
