## ADDED Requirements

### Requirement: 已識別訂單的變更請求 MUST 發起 tool 呼叫進入審批

當使用者訊息已識別訂單並要求退款或取消時，訂單請求步驟 MUST 在同一輪發起對應的訂單 tool 呼叫，由 durable 人工審批流程接手。系統 MUST NOT 以模型文字追問原因、索取確認或索取核准來取代審批步驟。使用者未提供原因時 MUST 使用既有的 `other` 原因代碼，MUST NOT 推測其他原因。未識別訂單時 MUST NOT 發起變更 tool 呼叫。

#### Scenario: 未提供原因的退款請求

- **GIVEN** 使用者訊息為「幫我把訂單 ORD-1001 退款」，沒有提供原因
- **WHEN** 訂單請求步驟處理該訊息
- **THEN** MUST 發起一次退款 tool 呼叫，原因代碼為 `other`
- **AND** 操作 MUST 進入等待人工審批
- **AND** 在審批前 MUST NOT 呼叫訂單系統

#### Scenario: 已提供原因的請求

- **GIVEN** 使用者訊息已識別訂單並說明商品損壞
- **WHEN** 訂單請求步驟處理該訊息
- **THEN** MUST 發起 tool 呼叫，原因代碼對應使用者提供的原因
- **AND** 操作 MUST 進入等待人工審批

#### Scenario: 未識別訂單

- **GIVEN** 使用者訊息為「我要退款」，沒有識別任何訂單
- **WHEN** 訂單請求步驟處理該訊息
- **THEN** MUST NOT 發起任何訂單 tool 呼叫
- **AND** 回覆 MUST 說明這次沒有建立申請，並請使用者提供訂單編號與要執行的操作

#### Scenario: 應發起呼叫但模型未發起

- **GIVEN** 使用者訊息已識別訂單，但模型沒有回傳 tool 呼叫
- **WHEN** 系統產生回覆
- **THEN** 回覆 MUST 是由系統決定的固定文字，MUST NOT 顯示模型自行產生的文字
- **AND** 回覆 MUST 說明這次沒有建立申請
- **AND** MUST NOT 建立操作紀錄或呼叫訂單系統

#### Scenario: 一則訊息識別多筆訂單

- **GIVEN** 使用者訊息要求退款兩筆不同訂單
- **WHEN** 訂單請求步驟處理該訊息
- **THEN** MUST 為每筆訂單各發起一次 tool 呼叫
- **AND** 每筆操作 MUST 各自進入等待人工審批

#### Scenario: 狀態查詢不得變成變更

- **GIVEN** 使用者詢問 ORD-1001 既有退款申請的狀態
- **WHEN** 訂單請求步驟處理該訊息
- **THEN** MUST 只發起狀態查詢，MUST NOT 發起變更 tool 呼叫

#### Scenario: 假設性問句不得變成變更

- **GIVEN** 使用者只是詢問「如果我想退 ORD-1001，會發生什麼事？」
- **WHEN** 訂單請求步驟處理該訊息
- **THEN** MUST NOT 發起變更 tool 呼叫
- **AND** MUST NOT 建立操作紀錄或呼叫訂單系統
- **AND** SHOULD NOT 發起狀態查詢；發生時屬於已知限制，MUST 依評測規格揭露

#### Scenario: 詢問可行性不得變成變更

- **GIVEN** 使用者詢問「假設而言，ORD-1002 還能退款嗎？」，沒有要求現在執行，也沒有詢問既有申請
- **WHEN** 訂單請求步驟處理該訊息
- **THEN** MUST NOT 發起變更 tool 呼叫
- **AND** SHOULD NOT 發起狀態查詢；發生時屬於已知限制，MUST 依評測規格揭露

#### Scenario: 以問句形式提出的請求仍是請求

- **GIVEN** 使用者訊息為「可以幫我把 ORD-1001 退款嗎？」，是請系統代為執行
- **WHEN** 訂單請求步驟處理該訊息
- **THEN** MUST 發起一次退款 tool 呼叫，並進入等待人工審批

#### Scenario: 原因代碼不影響冪等識別

- **GIVEN** 同一使用者對同一訂單的兩次退款請求，一次原因為 `other`，另一次為 `damaged`
- **WHEN** 系統推導 business effect key
- **THEN** 兩次的 key MUST 相同，後一次 MUST 依既有規則去重

#### Scenario: 模型失敗、逾時或取消

- **GIVEN** 訂單請求步驟呼叫模型時發生供應商失敗、逾時或使用者取消
- **WHEN** 該步驟結束
- **THEN** MUST NOT 建立操作紀錄或呼叫訂單系統
- **AND** 既有的失敗與取消語意 MUST 不變
