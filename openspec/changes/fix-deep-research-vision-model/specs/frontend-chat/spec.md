## ADDED Requirements

### Requirement: 圖片辨識活動 MUST 顯示 backend 回傳的實際模型
深度研究的研究流程 Timeline MUST 在收到圖片辨識節點更新時顯示圖片辨識活動，並顯示 backend 回傳的實際模型 id。frontend MUST NOT 寫死任何模型名稱，MUST NOT 以模型選單的值代替。活動項目 MUST 使用既有 known runtime event 形狀，不新增 event type。

#### Scenario: 圖片辨識成功
- **GIVEN** 圖片辨識節點更新的結果為成功，模型 id 為 `qwen3.5-flash`
- **WHEN** frontend 處理該 stream update
- **THEN** Timeline MUST 顯示圖片辨識完成的活動項目
- **AND** 該項目 MUST 顯示模型 `qwen3.5-flash`

#### Scenario: 模型 id 來自 backend 而非選單
- **GIVEN** 使用者在模型選單選擇 `Qwen Plus`
- **AND** 圖片辨識節點更新的模型 id 為 `qwen3.5-flash`
- **WHEN** frontend 顯示圖片辨識活動
- **THEN** 該項目 MUST 顯示 `qwen3.5-flash`，MUST NOT 顯示 `qwen-plus`

#### Scenario: 圖片辨識失敗
- **GIVEN** 圖片辨識節點更新的結果為失敗，模型 id 為 `qwen3.5-flash`
- **WHEN** frontend 處理該 stream update
- **THEN** Timeline MUST 顯示圖片辨識失敗的活動項目與模型 id
- **AND** MUST NOT 顯示 provider 原始錯誤全文、endpoint 或憑證
- **AND** frontend MUST NOT 解析或顯示 backend 失敗結果中的 ErrorEnvelope 字串，只顯示固定的安全訊息

#### Scenario: 其他工具文案不受影響
- **GIVEN** 同一 run 中有其他工具成功與失敗的事件
- **WHEN** frontend 顯示圖片辨識活動與其他工具活動
- **THEN** 其他工具 MUST 維持既有「工具完成」「工具錯誤」文案

#### Scenario: 圖片辨識結果格式不符
- **GIVEN** 圖片辨識節點更新缺少結果，或結果欄位格式不符
- **WHEN** frontend 處理該 stream update
- **THEN** frontend MUST 略過該值且不得崩潰
- **AND** 同一 update 中其他有效事件 MUST 照常顯示
