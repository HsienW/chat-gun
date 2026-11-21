## Why

使用者在 Gun Chat 開啟「深度研究」後附加圖片，模型的回答看起來完全沒看到圖片內容。

排查（CCR 唯讀推導，尚未 live 實測）確認圖片在 frontend 與 BFF 都完整送達 `deep_researcher`，問題出在 backend 的看圖步驟：

1. **看圖步驟用錯模型**。frontend 送出深度研究時，會把模型選單的值放進 `reasoning_model`（選單只有 `qwen-plus`／`qwen-max`／`qwen-turbo`，預設 `qwen-plus`）。`deep_researcher` 的圖片辨識步驟把這個值當成「呼叫端指定模型」傳給 vision 用途；LLM Gateway 的解析順序是呼叫端指定優先，因此 `QWEN_VISION_MODEL` 與預設生成模型 `qwen3.5-flash` 都被覆蓋，圖片實際送給純文字模型 `qwen-plus`。專案自己的規格與 archive 文件也把 `qwen-plus` 視為純文字模型（vision 對應為 `qwen-vl-plus`）。
2. **能力檢查沒有攔住**。Gateway 只依用途宣告 `supportsVision`，不看實際模型，vision 能力檢查永遠通過。
3. **失敗被當成觀察結果**。看圖呼叫失敗時，錯誤內容被當成「圖片觀察結果」交給 planner 與最終回答，使用者只看到「模型好像沒收到圖」，沒有明確的降級訊號。
4. **畫面看不出用了哪個模型**。研究流程 Timeline 沒有圖片辨識這一步，使用者無從得知圖片由哪個模型辨識；模型選單又顯示 `Qwen Plus`，容易誤以為看圖也用它。

這違反既有規格 `backend-model-runtime` 的 Vision Model Routing（看圖 MUST 使用 vision 模型、不支援時 MUST NOT 靜默成功）。根據程式推斷，自 frontend 模型選單改為 Qwen 後，這條路徑就一直以使用者選擇的模型看圖。

## What Changes

- **圖片辨識固定使用 vision 用途設定的模型**：`deep_researcher` 的圖片辨識步驟 MUST NOT 採用使用者在模型選單選擇的 `reasoning_model`，改由 vision 用途的既有解析順序決定（`QWEN_VISION_MODEL` → legacy 設定 → 預設生成模型 `qwen3.5-flash`）。
- **圖片辨識結果結構化**：新增可序列化的圖片辨識結果，記錄狀態（成功、失敗）、實際使用的 provider 與模型 id、圖片數量，以及失敗時的 ErrorEnvelope。
- **失敗改為明確降級**：看圖失敗（provider 錯誤、能力不支援、逾時）時，錯誤 MUST NOT 再被當成圖片觀察結果；planner 與最終回答收到的是明確的「圖片無法辨識」狀態，最終回答 MUST 告知使用者圖片未能分析。取消 MUST 照常向上傳遞，不得轉成降級結果。
- **frontend 顯示實際看圖模型**：研究流程 Timeline 新增「圖片辨識」項目，顯示 backend 回傳的實際模型 id（目前設定下即為 `qwen3.5-flash`）；失敗時顯示失敗與模型 id。frontend MUST NOT 寫死模型名稱。

## Capabilities

### New Capabilities

- `deep-research-image-recognition`：深度研究的圖片辨識結果契約、降級語意與取消行為。

### Modified Capabilities

- `backend-model-runtime`：修改「Vision Model Routing」，明確規定使用者選擇的模型不套用到 vision 用途，並補上失敗與逾時語意。
- `frontend-chat`：新增「圖片辨識活動顯示實際模型」需求。

## Goals

- 開啟深度研究並附加圖片時，圖片一定送到 vision 用途設定的模型。
- 看圖失敗時，使用者能從回答與 Timeline 明確知道圖片沒有被分析。
- 使用者能在畫面上看到圖片實際由哪個模型辨識（例如 `qwen3.5-flash`）。

## Non-Goals

- 不改變深度研究其他步驟（planner、research、synthesis）對 `reasoning_model` 的使用方式；這些步驟仍會使用模型選單的值，另案處理。
- 不修改 frontend 模型選單的選項、預設值或 `reasoning_model` 的送出格式（`frontend-model-selection` 規格不變）。
- 不讓 `chatbot`（深度研究關閉）支援看圖；深度研究關閉時附件仍會被轉成文字佔位，另案處理。
- 不新增模型能力清單，也不依模型名稱判斷能力。
- 不修改 BFF。

## Impact

- **backend**：`deep_researcher` 的圖片辨識節點、Graph State（新增圖片辨識結果欄位）、planner 與最終回答取用圖片證據的方式；需要由 LLM Gateway 提供「依用途解析後的 provider／模型 id」給呼叫端（沿用既有解析函式，不新增依模型名稱的判斷）。
- **frontend**：runtime event node adapter 新增 `analyze_images` 節點對應與 Timeline 文案。
- **bff**：無變更。
- **相容性**：Graph ID、BFF Route、request shape 不變；State 只新增欄位，舊 checkpoint 缺少該欄位時視為「沒有圖片辨識結果」。`imageObservations` 欄位保留，只是失敗時不再寫入錯誤內容。

## Risks

- 使用者選擇的模型不再影響看圖步驟；這是刻意的行為改變，需在 Timeline 顯示實際模型以避免誤解。
- `qwen-plus` 在 DashScope 收到圖片時是報錯還是忽略圖片尚未 live 驗證；本 Change 的修正兩種情況都涵蓋，但 live smoke 需另外執行並記錄。
- 模型 id 會出現在畫面上；模型 id 屬於非機密設定值，不得連帶顯示 endpoint、API Key 或 Authorization header。

## Rollback

回退本 Change 的 backend 與 frontend commit 即可；不涉及資料遷移。新增的 State 欄位在回退後會被忽略。
