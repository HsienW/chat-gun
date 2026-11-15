# evaluation-model-provenance Specification

## Purpose

規範知識與商務評測的生成模型、provider 回報模型、thinking 與 endpoint 來源紀錄，並維持既有 provenance 相容性。

## Requirements

### Requirement: 評測 provenance 記錄生成模型、thinking 與 endpoint

知識檢索評測、商務鏈評測與訂單請求 golden 評測的 provenance MUST 記錄：每個生成用途解析後的模型、本次 run 實際送出的有效 thinking 值（provider 不支援時為 `null`）、provider 名稱，以及 endpoint 主機名稱。endpoint 主機 MUST 取自 Gateway 的有效 endpoint 唯讀查詢（含未設定 base URL 時的內建預設），MUST NOT 為空字串；查詢失敗時評測 MUST 在建立模型與寫入任何結果之前失敗。endpoint 欄位 MUST 只含主機名稱，MUST NOT 含路徑、query、API Key 或 Authorization 資訊。既有 provenance 欄位 MUST 保留且語意不變。

#### Scenario: flash 評測的 provenance
- **GIVEN** 生成模型為 `qwen3.5-flash`、thinking 關閉、endpoint 為新加坡主機
- **WHEN** 任一評測完成並寫出 provenance
- **THEN** provenance MUST 記錄每個生成用途的模型為 `qwen3.5-flash`
- **AND** MUST 記錄 thinking 為 `false`
- **AND** MUST 記錄 provider 為 `qwen` 與 endpoint 主機名稱

#### Scenario: 報表摘要
- **WHEN** 評測寫出 Markdown 報表
- **THEN** 報表 MUST 有一行列出生成模型、thinking 值與 endpoint 主機

#### Scenario: 既有欄位相容
- **WHEN** 讀取本變更之前產生的 provenance
- **THEN** 讀取端 MUST 把缺少的新欄位視為未記錄，不得報錯或改寫舊檔

#### Scenario: 不洩漏憑證
- **GIVEN** base URL 含 query 或使用者資訊
- **WHEN** 寫出 provenance
- **THEN** provenance 與報表 MUST 只含主機名稱

#### Scenario: 未設定 base URL
- **GIVEN** provider 為 `qwen` 且未設定 base URL
- **WHEN** 評測寫出 provenance
- **THEN** `llmEndpointHost` MUST 為 Gateway 內建預設 endpoint 的主機名稱

#### Scenario: endpoint 設定無效
- **GIVEN** base URL 無法解析
- **WHEN** 啟動任一評測
- **THEN** 評測 MUST 在建立模型與寫入任何結果之前失敗，錯誤 MUST NOT 含設定值或憑證

### Requirement: 評測記錄 provider 實際回報的模型

評測 MUST 收集本次 run 中所有生成回應裡 provider 回報的模型名稱，去重後寫入 provenance。判斷依據 MUST 只有 Gateway 回應 metadata 的 `provider_model` 欄位；MUST NOT 讀取以設定模型代填的 `model` 欄位，也不得以設定值代填。回應缺少 `provider_model` 欄位時 MUST 視為該次未回報。`observedProviderModelsStatus` MUST 為：所有已收到的回應都有回報時 `reported`；都沒有回報時 `unreported`；部分有、部分沒有時 `partial`。收集 MUST 在評測模組內完成；評測 MUST NOT 改變 Gateway 回傳給 Graph 的內容。

#### Scenario: provider 回報模型
- **GIVEN** provider 回應帶有模型名稱
- **WHEN** 評測完成
- **THEN** provenance MUST 列出去重後的實際模型名稱

#### Scenario: provider 未回報模型
- **GIVEN** provider 回應沒有模型欄位
- **WHEN** 評測完成
- **THEN** provenance MUST 記錄空集合與 `unreported`
- **AND** MUST NOT 把 Gateway 代填於 `model` 的設定模型列入集合

#### Scenario: 部分回應未回報模型
- **GIVEN** 同一個 run 中，部分回應的 `provider_model` 有值、部分為 `null`
- **WHEN** 評測完成
- **THEN** provenance MUST 只列出有回報的模型名稱，並標示 `partial`

#### Scenario: 實際模型與設定不同
- **GIVEN** 設定為 `qwen3.5-flash`，provider 回報不同的模型名稱
- **WHEN** 評測完成
- **THEN** provenance MUST 同時保留設定模型與實際回報模型，不得互相覆蓋

#### Scenario: 評測中途失敗或取消
- **GIVEN** 評測在部分案例完成後因 provider 錯誤、逾時或取消而中止
- **WHEN** 評測依既有語意結束
- **THEN** 若有寫出 provenance，MUST 只列出已收到的回應中的模型
- **AND** MUST NOT 把未完成的 run 標示為可發布

### Requirement: live 評測的模型設定與 production graph 一致

live 商務評測與訂單請求 golden 評測建立生成模型時，MUST 套用與 production `shopping_assistant` 相同的模型、temperature 與 thinking 設定。

#### Scenario: thinking 設定一致
- **GIVEN** Gun Shop thinking 有效值為關閉
- **WHEN** 執行 live 商務評測
- **THEN** 評測送出的每個生成請求 MUST 帶有關閉設定
- **AND** provenance 的 thinking 欄位 MUST 為 `false`

#### Scenario: 設定不合法時不執行
- **GIVEN** Gun Shop 模型設定驗證失敗
- **WHEN** 執行 live 商務評測
- **THEN** 評測 MUST 在建立模型與寫入任何結果之前失敗
