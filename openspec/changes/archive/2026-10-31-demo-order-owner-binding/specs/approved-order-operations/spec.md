## MODIFIED Requirements

### Requirement: 冪等鍵識別邏輯業務操作且並行重複只提交一次

訂單變更的 business effect key MUST 由操作種類、server 端的申請者 principal、訂單識別與正規化的操作明細推導，MUST NOT 包含 attempt、tool call 識別、run 識別或自由文字理由。模擬訂單擁有者綁定對申請者生效時，推導 MUST 另外納入綁定 epoch；綁定未生效時，推導結果 MUST 與未引入綁定前完全相同。同一申請者在同一 trusted scope 內的同一邏輯操作 MUST 至多提交一次。第二次提交 MUST 可觀察為去重，並指向原操作，MUST NOT 被呈現為失敗。去重 MUST NOT 跨申請者發生，非擁有者的申請 MUST NOT 得到他人操作的任何資訊。

#### Scenario: 並行重複提交

- **GIVEN** 同一邏輯退款的兩次已核准提交同時到達 dispatch
- **WHEN** 兩者並行執行
- **THEN** 訂單系統 MUST 只提交一次，ledger MUST 只有一筆已提交的 business effect
- **AND** 另一次提交 MUST 回傳去重結果並指向原操作

#### Scenario: 已確認後的重複提交

- **GIVEN** 某邏輯退款已確認
- **WHEN** 使用者以不同措辭或理由再次申請相同訂單與明細的退款並核准
- **THEN** 訂單系統 MUST NOT 再次提交
- **AND** 結果 MUST 為去重，並帶回原操作的確認結果

#### Scenario: 去重結果使用本次提交的識別

- **GIVEN** 一次提交被判定為重用已提交結果
- **WHEN** 發出該提交的操作狀態
- **THEN** 狀態的 tool call 參照與操作識別 MUST 屬於本次提交，原操作 MUST 只出現在去重參照中
- **AND** 原操作的狀態事件 MUST NOT 被這次提交改變

#### Scenario: 未提交失敗後重新申請

- **GIVEN** 某退款因訂單系統在 dispatch 前不可用而以未提交失敗結束
- **WHEN** 同一使用者稍後重新申請相同退款並再次核准
- **THEN** 新申請 MUST 實際執行一次，MUST NOT 被判定為去重
- **AND** 原失敗 MUST NOT 被自動重試

#### Scenario: 不同明細為不同操作

- **GIVEN** 某訂單的第一個商品明細已確認退款
- **WHEN** 申請同一訂單另一個商品明細的退款
- **THEN** 該申請 MUST 視為不同的邏輯操作並獨立執行

#### Scenario: 他人訂單的重複申請不得得到去重結果

- **GIVEN** 使用者 A 的某筆訂單已確認退款
- **WHEN** 同 tenant 的使用者 B 對同一訂單申請相同退款並核准
- **THEN** 結果 MUST 為查無訂單，MUST NOT 為去重
- **AND** 回應 MUST NOT 含 A 的操作識別、訂單系統操作識別或任何可推知該退款存在的資訊，訂單系統 MUST NOT 提交退款

#### Scenario: 同一使用者在不同對話重複申請

- **GIVEN** 某使用者在一個對話中已確認某訂單的退款
- **WHEN** 同一使用者在另一個對話申請相同退款並核准
- **THEN** 結果 MUST 為去重並指向原操作
- **AND** 訂單系統 MUST NOT 再次提交

#### Scenario: 綁定未生效時 key 與既有紀錄相容

- **GIVEN** 模擬訂單擁有者綁定未啟用，或申請者與綁定來源不符
- **WHEN** 推導 business effect key
- **THEN** 結果 MUST 與未引入綁定前的推導結果完全相同
- **AND** 既有 ledger 紀錄 MUST 不需遷移即可繼續去重

#### Scenario: 不同綁定 epoch 為不同邏輯操作

- **GIVEN** 綁定對申請者生效，某退款已在 epoch `e1` 確認
- **WHEN** 同一申請者在 epoch `e2` 申請相同訂單與明細的退款並核准
- **THEN** 該申請 MUST 視為不同的邏輯操作並實際提交一次
- **AND** `e1` 的操作與其 ledger 紀錄 MUST NOT 被修改

---

### Requirement: 訂單 tool 失敗分類穩定且不洩漏他人訂單

訂單 tool MUST 以穩定的 typed failure 區分輸入錯誤、查無訂單、不符資格、操作已存在、dispatch 前 provider 不可用與 dispatch 後 provider 逾時。訂單擁有者 MUST 以生效的 fixture 擁有者判斷：模擬訂單擁有者綁定對申請者生效時為綁定目標，否則為目前 trusted tenant 與 principal。不屬於生效擁有者的訂單 MUST 與查無訂單回傳相同結果。provider error MUST NOT 被轉為查無訂單。

#### Scenario: 他人訂單

- **GIVEN** 訂單屬於同 tenant 的另一個 principal
- **WHEN** 目前 principal 申請退款
- **THEN** MUST 回傳查無訂單
- **AND** 回應 MUST NOT 透露該訂單存在

#### Scenario: dispatch 前 provider 不可用

- **GIVEN** 訂單系統在 dispatch 前即回報不可用
- **WHEN** 已核准的退款嘗試執行
- **THEN** 操作 MUST 以失敗結束且標記未提交
- **AND** MUST NOT 被回報為查無訂單

#### Scenario: 不符退款資格

- **GIVEN** 訂單依其資料不符退款資格
- **WHEN** 已核准的退款執行
- **THEN** 操作 MUST 以 typed 不符資格失敗結束
- **AND** ledger MUST NOT 有已提交的 business effect

#### Scenario: 綁定目標不擁有的訂單

- **GIVEN** 綁定對申請者生效，目標擁有者為 `synthetic-shopper-a`
- **WHEN** 申請者對屬於 `synthetic-shopper-b` 的訂單申請取消並核准
- **THEN** MUST 回傳查無訂單
- **AND** 回應 MUST NOT 透露該訂單存在
