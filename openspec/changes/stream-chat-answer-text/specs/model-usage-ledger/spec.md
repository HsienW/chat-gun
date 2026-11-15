## MODIFIED Requirements

### Requirement: provider 未回報用量時不得以 0 入帳

provider 回應沒有用量欄位時，backend MUST 記錄穩定事件 `usage_missing`。若單價表為該模型提供缺用量估算值，MUST 以估算值入帳並標記 `estimated`；否則 MUST 標記 `unpriced`。任何情況 MUST NOT 以 0 金額標記為 `priced`。

呼叫端可為缺值用量提供缺值原因 `usageMissingReason`，其值 MUST 屬於封閉集合 `stream_aborted`、`usage_frame_missing`。提供原因時，`usage_missing` 事件 MUST 帶上該原因；未提供時，事件 MUST 維持原有內容。收到集合外的值時，事件 MUST 以 `unknown` 記錄原因，且 MUST NOT 中斷計量。缺值原因 MUST NOT 影響計價狀態、入帳金額、未計價筆數或儲存格式；用量齊全時提供的原因 MUST 被忽略。

#### Scenario: 有估算值

- **GIVEN** provider 回應沒有用量欄位，且單價表為該模型設定了估算值 E
- **WHEN** Gateway 處理回應
- **THEN** backend 記錄 `usage_missing` 事件
- **AND** 帳本增加 E，計價狀態為 `estimated`

#### Scenario: 沒有估算值

- **GIVEN** provider 回應沒有用量欄位，且該模型沒有估算值
- **WHEN** Gateway 處理回應
- **THEN** 該筆計價狀態為 `unpriced`，當日未計價筆數加一

#### Scenario: 串流中止帶缺值原因

- **GIVEN** 串流上游嘗試在送出 usage 前被中止，呼叫端以 `usageMissingReason = "stream_aborted"` 記錄缺值用量
- **WHEN** 帳本處理該筆用量
- **THEN** `usage_missing` 事件 MUST 帶上原因 `stream_aborted`
- **AND** 計價狀態與入帳金額 MUST 與未帶原因時相同

#### Scenario: 非串流路徑不帶原因

- **GIVEN** 非串流呼叫的 provider 回應沒有用量欄位，呼叫端未提供 `usageMissingReason`
- **WHEN** 帳本處理該筆用量
- **THEN** `usage_missing` 事件 MUST 與本次修改前相同，不帶原因

#### Scenario: 集合外的原因值

- **GIVEN** 呼叫端以集合外的值提供 `usageMissingReason`
- **WHEN** 帳本處理該筆缺值用量
- **THEN** `usage_missing` 事件 MUST 以 `unknown` 記錄原因
- **AND** 計量 MUST 照常完成，不拋出錯誤

#### Scenario: 用量齊全時提供原因

- **GIVEN** provider 回報了完整用量，呼叫端仍提供 `usageMissingReason`
- **WHEN** 帳本處理該筆用量
- **THEN** 帳本 MUST 忽略該原因，不記錄 `usage_missing`
- **AND** 計價狀態為 `priced`，金額依單價表計算
