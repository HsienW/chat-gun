## MODIFIED Requirements

### Requirement: Vision Model Routing
Backend Runtime MUST route image analysis requests to a vision-capable model and preserve existing image safety constraints. 圖片辨識請求的模型 MUST 由 vision 用途的設定解析（vision 專屬設定 → legacy 設定 → 預設生成模型），MUST NOT 採用使用者在 frontend 模型選單選擇、經 `reasoning_model` 送入的模型。

#### Scenario: Qwen vision model receives image content parts
- **GIVEN** a validated user message contains `image_url` content parts, including data URLs
- **AND** `LLM_PROVIDER=qwen`
- **WHEN** Backend performs image analysis
- **THEN** Backend MUST use the Qwen vision model for vision purpose
- **AND** the Chat Completions request MUST preserve supported text and image content parts

#### Scenario: 使用者選擇的模型不影響圖片辨識
- **GIVEN** 深度研究 run 的 `reasoning_model` 為 `qwen-plus`
- **AND** vision 專屬設定與 legacy 設定都未設定
- **AND** 使用者訊息包含一張有效圖片
- **WHEN** Backend 執行圖片辨識
- **THEN** 圖片辨識請求的模型 MUST 為預設生成模型 `qwen3.5-flash`
- **AND** 圖片辨識請求 MUST 包含該圖片的 `image_url` content part

#### Scenario: vision 專屬設定優先於預設模型
- **GIVEN** vision 專屬設定為 `qwen-vl-plus`
- **AND** 深度研究 run 的 `reasoning_model` 為 `qwen-max`
- **WHEN** Backend 執行圖片辨識
- **THEN** 圖片辨識請求的模型 MUST 為 `qwen-vl-plus`

#### Scenario: Vision is unsupported
- **GIVEN** the selected provider or model purpose does not support vision
- **WHEN** Backend receives an image analysis request
- **THEN** Backend MUST return a structured provider capability error or explicit degradation
- **AND** Backend MUST NOT silently report success

#### Scenario: 圖片辨識逾時
- **GIVEN** vision 模型請求超過 Gateway 逾時設定
- **WHEN** Backend 執行圖片辨識
- **THEN** Backend MUST 回報明確降級並保留逾時錯誤碼
- **AND** Backend MUST NOT 將逾時視為成功或產生圖片觀察內容

#### Scenario: 圖片辨識被取消
- **GIVEN** run 在圖片辨識進行中被取消
- **WHEN** vision 模型請求因取消而中止
- **THEN** Backend MUST 將取消向上傳遞為 run 取消
- **AND** Backend MUST NOT 將取消轉成降級結果或繼續後續節點
