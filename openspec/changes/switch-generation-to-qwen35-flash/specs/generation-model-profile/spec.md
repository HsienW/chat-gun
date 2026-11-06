## ADDED Requirements

### Requirement: 預設生成模型為單一來源的 qwen3.5-flash

Backend MUST 以單一具型別的 Domain Constant 定義預設生成模型，值為 `qwen3.5-flash`。所有生成用途（chat、math、research、vision、tool）在呼叫端未指定、purpose 專屬設定與 legacy 設定都未設定時，MUST 解析為此預設模型。解析優先序 MUST 維持：呼叫端指定 → purpose 專屬設定 → legacy 設定 → 預設模型。Backend MUST NOT 依模型名稱改變 Domain Schema、Graph Edge 或業務邏輯。

#### Scenario: 未設定任何模型時所有用途都使用 qwen3.5-flash
- **GIVEN** provider 為 `qwen`
- **AND** 所有 purpose 專屬與 legacy 模型設定都未設定
- **WHEN** Backend 為 chat、math、research、vision、tool 各建立一次生成模型
- **THEN** 每次送出的請求模型 MUST 為 `qwen3.5-flash`

#### Scenario: 每個已註冊 graph 預設送出 qwen3.5-flash
- **GIVEN** 使用設定範例的生成模型值
- **WHEN** `chatbot`、`deep_researcher`、`shopping_assistant`、`math_agent`、`mcp_agent` 各以 fake provider 執行一次 run
- **THEN** 每個 run 送出的所有生成請求模型 MUST 為 `qwen3.5-flash`
- **AND** embedding 與 rerank 請求的模型 MUST 與變更前相同

#### Scenario: 設定值優先於預設模型
- **GIVEN** purpose 專屬設定指定 `qwen3.7-plus`
- **WHEN** Backend 為該用途建立生成模型
- **THEN** 請求模型 MUST 為 `qwen3.7-plus`
- **AND** 其他未設定的用途 MUST 仍為 `qwen3.5-flash`

#### Scenario: 模型切換不改變 Domain Contract
- **GIVEN** 同一組 fake provider 回應
- **WHEN** 生成模型分別設定為 `qwen3.5-flash` 與 `qwen3.7-plus`
- **THEN** Graph 輸出、Tool 輸入輸出、事件與錯誤碼的 Schema MUST 相同

### Requirement: Qwen 生成請求明確送出 thinking 設定且預設關閉

Provider MUST 以 capability `supportsThinkingControl` 宣告是否支援 thinking 控制。對宣告支援的 provider，Backend MUST 在每一個生成請求中明確送出 thinking 設定，包含 vision、JSON object 結構化輸出、Tool Calling、provider 重試與修復重送。有效值 MUST 依序取自：呼叫端明確傳入的值 → 入口預設 → 全站 thinking 預設設定 → `false`。全站 thinking 預設設定 MUST 只接受 `true` 或 `false`，未設定時為 `false`。對宣告不支援的 provider，Backend MUST NOT 送出 thinking 設定。是否送出 MUST NOT 依模型名稱判斷。

#### Scenario: 未設定時所有 graph 都送出關閉
- **GIVEN** provider 為 `qwen`，全站 thinking 預設未設定
- **WHEN** 任一已註冊 graph 發出生成請求
- **THEN** 請求 MUST 帶有明確的 thinking 關閉設定

#### Scenario: 結構化輸出、Tool Calling 與修復重送都帶 thinking 設定
- **GIVEN** provider 為 `qwen`
- **WHEN** Backend 發出 JSON object 請求、綁定 Tool 的請求，以及因 Tool 參數修復而重送的請求
- **THEN** 每一次請求 MUST 帶有相同的有效 thinking 設定

#### Scenario: provider 失敗重試仍帶相同設定
- **GIVEN** 第一次請求回傳 provider 錯誤並觸發重試
- **WHEN** Backend 重送請求
- **THEN** 重送的請求 MUST 帶有與第一次相同的 thinking 設定

#### Scenario: 呼叫端明確值優先
- **GIVEN** 全站 thinking 預設為 `false`
- **AND** 呼叫端明確傳入開啟
- **WHEN** Backend 發出生成請求
- **THEN** 請求 MUST 帶有開啟設定

#### Scenario: 全站預設格式錯誤拒絕啟動
- **GIVEN** 全站 thinking 預設設定為 `true`、`false` 以外的值
- **WHEN** Backend 啟動
- **THEN** 啟動 MUST 失敗並回報穩定的設定錯誤
- **AND** 錯誤 MUST NOT 包含任何憑證

#### Scenario: 不支援 thinking 控制的 provider
- **GIVEN** provider 宣告 `supportsThinkingControl: false`
- **WHEN** Backend 發出生成請求
- **THEN** 請求 MUST NOT 帶有 thinking 設定
- **AND** 若全站預設或入口設定明確要求開啟，啟動 MUST 失敗並回報設定錯誤

#### Scenario: 回應記錄實際送出的 thinking 值
- **WHEN** Backend 收到生成回應
- **THEN** 回應 metadata MUST 記錄該次請求實際送出的 thinking 值；provider 不支援時 MUST 記錄為未送出

#### Scenario: 請求取消
- **GIVEN** 生成請求進行中
- **WHEN** 呼叫端取消
- **THEN** Backend MUST 依既有取消語意中止請求，不得因 thinking 設定而重試或改送其他設定

### Requirement: Gun Shop thinking 一律關閉並在啟動時驗證

服務 `shopping_assistant` 的 backend 啟動流程，以及讀取 Gun Shop 模型設定的評測流程，MUST 驗證 Gun Shop 的 thinking 設定只能是未設定或關閉。未設定時有效值 MUST 為關閉，且 MUST NOT 受全站 thinking 預設影響。設定為開啟或其他值時 MUST 拒絕啟動，錯誤碼為 `invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED`。此驗證 MUST 適用於所有模式，不限於 demo 模式。

#### Scenario: 未設定時為關閉
- **GIVEN** Gun Shop thinking 設定未設定
- **AND** 全站 thinking 預設為開啟
- **WHEN** backend 啟動並執行一次 Gun Shop run
- **THEN** Gun Shop 的所有生成請求 MUST 帶有關閉設定

#### Scenario: 設定為開啟時拒絕啟動
- **GIVEN** Gun Shop thinking 設定為開啟
- **WHEN** backend 在非 demo 模式啟動
- **THEN** 啟動 MUST 失敗，錯誤碼為 `invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED`

#### Scenario: 評測讀取設定時同樣驗證
- **GIVEN** Gun Shop thinking 設定為開啟
- **WHEN** 執行 live 商務評測
- **THEN** 評測 MUST 在建立任何模型物件與寫入結果之前失敗

#### Scenario: 設定格式錯誤
- **GIVEN** Gun Shop thinking 設定為 `true`、`false` 以外的值
- **WHEN** backend 啟動
- **THEN** 啟動 MUST 失敗，錯誤碼為 `invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED`

### Requirement: 不新增模型層 fallback，provider 層 fallback 語意不變

Backend MUST NOT 因本變更新增以模型為單位的 fallback。既有 provider 層 fallback MUST 維持預設關閉，啟用時語意不變；fallback provider 解析出的模型 MUST 依相同的模型解析優先序決定。

#### Scenario: 預設不啟用 fallback
- **GIVEN** fallback 設定未設定
- **WHEN** 生成請求失敗
- **THEN** Backend MUST 依既有重試語意回報錯誤
- **AND** MUST NOT 改用其他模型重送

#### Scenario: 啟用 provider 層 fallback
- **GIVEN** 部署明確啟用 provider 層 fallback
- **WHEN** primary provider 逾時並切換至 fallback provider
- **THEN** fallback provider 的模型 MUST 依相同優先序解析
- **AND** fallback 請求 MUST 依該 provider 的 capability 決定是否送出 thinking 設定

### Requirement: 回滾只需改設定

把生成模型設定改回 `qwen3.7-plus` 或 `qwen-plus`（vision 為 `qwen-vl-plus`）MUST 足以讓所有生成用途改用該模型，不需修改程式。

#### Scenario: 以設定回滾
- **GIVEN** 所有 purpose 專屬模型設定改為 `qwen3.7-plus`
- **WHEN** backend 重啟並執行每個已註冊 graph 一次
- **THEN** 所有生成請求模型 MUST 為 `qwen3.7-plus`
- **AND** thinking 設定 MUST 仍依有效值明確送出

### Requirement: 新加坡國際 endpoint 相容性以手動 live probe 驗證

Backend MUST 提供預設跳過、需明確旗標才執行的 live probe，對設定的 endpoint 與預設生成模型驗證：純文字回應、JSON object 結構化輸出（通過 Runtime Validation）、Tool Calling、影像輸入，以及關閉 thinking 時沒有 reasoning token。probe 結果 MUST 寫入 evidence，包含 endpoint 主機、模型、日期與每項結果。probe 輸出 MUST NOT 包含 API Key、Authorization header 或模型回應全文。probe 未執行時，對應相容性 MUST 標示為未驗證。

#### Scenario: 預設不執行
- **GIVEN** probe 旗標未設定
- **WHEN** 執行 backend 測試
- **THEN** probe MUST 被跳過且不發出任何網路請求

#### Scenario: 執行成功
- **GIVEN** probe 旗標開啟，且已設定新加坡 endpoint 與該區域的 API Key
- **WHEN** 執行 probe
- **THEN** evidence MUST 逐項記錄 text、json_object、tool_calling、vision、thinking_off 的結果

#### Scenario: 單項失敗或逾時
- **GIVEN** probe 執行時某一項回傳 provider 錯誤或逾時
- **WHEN** probe 完成
- **THEN** 該項 MUST 記錄為失敗並附穩定錯誤分類（provider_error、timeout、schema_invalid、unsupported）
- **AND** 其他項目 MUST 繼續執行並各自記錄

#### Scenario: 缺少憑證
- **GIVEN** probe 旗標開啟但未設定 API Key
- **WHEN** 執行 probe
- **THEN** probe MUST 在發出請求前失敗，並記錄為未執行

#### Scenario: probe 被取消
- **GIVEN** probe 進行中
- **WHEN** 操作者中止
- **THEN** 已完成的項目 MUST 保留結果，未完成的項目 MUST 記錄為未執行
