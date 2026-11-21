## ADDED Requirements

### Requirement: 深度研究圖片辨識結果 MUST 結構化且帶出實際模型
深度研究 run 的當前 turn 包含有效圖片時，Backend MUST 產生可序列化的圖片辨識結果，包含狀態（成功或失敗）、實際使用的 provider、實際使用的模型 id 與圖片數量。provider 與模型 id MUST 取自 Gateway 依 vision 用途實際解析的值，MUST NOT 由 agent 自行寫死或依模型名稱推導。當前 turn 沒有圖片時 MUST NOT 產生圖片辨識結果。每個新 turn MUST 清除上一輪的圖片辨識結果。

#### Scenario: 圖片辨識成功
- **GIVEN** 當前 turn 包含兩張有效圖片
- **AND** vision 模型解析為 `qwen3.5-flash` 且回傳非空的觀察文字
- **WHEN** 深度研究執行圖片辨識
- **THEN** 圖片辨識結果狀態 MUST 為成功
- **AND** 結果的模型 id MUST 為 `qwen3.5-flash`，圖片數量 MUST 為 2
- **AND** 觀察文字 MUST 提供給研究規劃與最終回答作為圖片證據

#### Scenario: 當前 turn 沒有圖片
- **GIVEN** 當前 turn 只有文字
- **WHEN** 深度研究執行
- **THEN** Backend MUST NOT 呼叫 vision 模型
- **AND** MUST NOT 產生圖片辨識結果

#### Scenario: 上一輪結果不得殘留
- **GIVEN** 上一個 turn 有成功的圖片辨識結果
- **AND** 當前 turn 只有文字
- **WHEN** 深度研究執行當前 turn
- **THEN** 當前 turn 的圖片辨識結果 MUST 為不存在

#### Scenario: 舊 checkpoint 缺少圖片辨識結果欄位
- **GIVEN** 從本變更前建立的 checkpoint 繼續執行
- **WHEN** Graph 讀取 State
- **THEN** 缺少的圖片辨識結果 MUST 視為不存在，Graph MUST 正常執行

### Requirement: 圖片辨識失敗 MUST 明確降級而非當成觀察內容
圖片辨識因 provider 錯誤、能力不支援、逾時或空回應而失敗時，Backend MUST 將圖片辨識結果標為失敗並附上 ErrorEnvelope（stage 為 `image_recognition`），MUST NOT 將錯誤內容寫入圖片觀察內容。研究規劃與最終回答 MUST 收到「圖片辨識失敗、沒有可用圖片內容」的明確狀態；最終回答 MUST 告知使用者圖片未能分析，MUST NOT 猜測圖片內容。ErrorEnvelope MUST NOT 包含 API Key、Authorization header、圖片 data URL 或 provider 回應全文。

#### Scenario: provider 回傳錯誤
- **GIVEN** 當前 turn 包含一張有效圖片
- **AND** vision 模型請求回傳 provider 錯誤
- **WHEN** 深度研究執行圖片辨識
- **THEN** 圖片辨識結果狀態 MUST 為失敗，且帶有 stage 為 `image_recognition` 的 ErrorEnvelope
- **AND** 圖片觀察內容 MUST 為空
- **AND** 最終回答的模型輸入 MUST 包含圖片辨識失敗的明確說明，且不含 ErrorEnvelope 原文

#### Scenario: vision 模型回傳空內容
- **GIVEN** vision 模型回傳空字串
- **WHEN** 深度研究執行圖片辨識
- **THEN** 圖片辨識結果狀態 MUST 為失敗
- **AND** MUST NOT 被視為成功的空觀察

#### Scenario: 圖片辨識逾時
- **GIVEN** vision 模型請求逾時
- **WHEN** 深度研究執行圖片辨識
- **THEN** 圖片辨識結果狀態 MUST 為失敗，ErrorEnvelope MUST 保留逾時錯誤碼
- **AND** run MUST 繼續執行研究規劃並以降級狀態完成回答

#### Scenario: 圖片辨識時取消
- **GIVEN** run 在圖片辨識進行中被取消
- **WHEN** vision 模型請求中止
- **THEN** run MUST 以取消終止
- **AND** MUST NOT 寫入失敗的圖片辨識結果，也 MUST NOT 進入研究規劃
