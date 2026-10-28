# order-operation-status-surface Specification

## Purpose

定義前端訂單操作卡片 `order_operation_status@1` 的呈現契約，包括審批互動（核准、拒絕、取消申請）、審批期限、狀態單調性、typed 錯誤顯示，以及遇到未知版本時的安全降級。

## Requirements

### Requirement: 所有操作生命週期狀態對使用者可區分

使用者介面 MUST 以可區分的方式呈現下列訂單操作狀態：requested、awaiting_approval、approved、executing、confirmed、deduplicated、failed、approval_denied、approval_expired、cancelled_before_effect、outcome_unknown。狀態 MUST 來自後端版本化的操作狀態事件，前端只做顯示映射。requested 與 approved MUST NOT 呈現為 confirmed。

#### Scenario: 審批中與執行中可區分

- **GIVEN** 一筆退款依序經歷 awaiting_approval、approved、executing
- **WHEN** 介面收到各狀態事件
- **THEN** 每個狀態 MUST 以不同標籤呈現
- **AND** 在收到 confirmed 之前 MUST NOT 顯示為已確認

#### Scenario: 審批拒絕、逾期與生效前取消可區分

- **GIVEN** 三筆操作分別以 approval_denied、approval_expired 與 cancelled_before_effect 結束
- **WHEN** 介面呈現
- **THEN** 三者 MUST 有不同標籤與說明

#### Scenario: 未知結果說明

- **GIVEN** 一筆操作為 outcome_unknown 且附 reconciliation task 識別
- **WHEN** 介面呈現
- **THEN** MUST 說明結果待確認、已建立核對工作，並提示不要重複申請
- **AND** MUST NOT 呈現為成功或失敗

#### Scenario: 去重說明

- **GIVEN** 一次提交的結果為 deduplicated 並指向原操作
- **WHEN** 介面呈現
- **THEN** MUST 說明與既有申請相同、未重複執行，並呈現原操作的狀態
- **AND** MUST NOT 呈現為失敗

---

### Requirement: 狀態只能單調前進且 terminal 不回退

前端 MUST 以 tool call 參照與狀態版本對狀態事件去重與排序。較舊版本的事件與 terminal 之後的非 terminal 事件 MUST 被忽略。

#### Scenario: 亂序事件

- **GIVEN** 介面已呈現某操作為 confirmed
- **WHEN** 晚到一筆 executing 事件
- **THEN** 介面 MUST 維持 confirmed

#### Scenario: 重複事件

- **GIVEN** 同一操作與狀態版本的事件到達兩次
- **WHEN** 介面處理
- **THEN** 介面 MUST 只呈現一次狀態變化

#### Scenario: 串流中斷後重新載入

- **GIVEN** 一筆操作處於等待審批時串流中斷
- **WHEN** 使用者重新載入對話
- **THEN** 介面 MUST 依後端權威狀態再次呈現等待審批與審批操作

---

### Requirement: 審批卡片以一次性 resume 回傳人工決定

等待審批時介面 MUST 顯示操作摘要、server 提供的審批期限與核准、拒絕、取消申請三個選項。核准與拒絕 MUST 經既有 resume 機制回傳，取消申請 MUST 經既有取消輸入送出；送出期間 MUST 防止重複送出。resume 失敗時 MUST 顯示 typed 錯誤，MUST NOT 假設決定已生效。期限已過但尚未收到 server 逾期狀態時，介面 MAY 顯示期限已過的提示，MUST NOT 自行將狀態改為審批逾期。

#### Scenario: 核准

- **GIVEN** 介面顯示等待審批的退款
- **WHEN** 使用者按下核准
- **THEN** 介面 MUST 送出一次核准 resume
- **AND** 狀態 MUST 依後端事件前進，而非由前端直接設為已確認

#### Scenario: 連續點擊

- **GIVEN** 使用者快速連續按下核准兩次
- **WHEN** 介面處理點擊
- **THEN** MUST 只送出一次 resume

#### Scenario: resume 失敗或逾時

- **GIVEN** resume 請求失敗或逾時
- **WHEN** 介面收到錯誤
- **THEN** MUST 顯示 typed 錯誤並保留可重新決定的狀態
- **AND** MUST NOT 顯示為已核准或已確認

#### Scenario: 使用者取消申請

- **GIVEN** 介面顯示等待審批的退款
- **WHEN** 使用者選擇取消申請
- **THEN** 介面 MUST 經既有取消輸入送出取消
- **AND** 最終狀態 MUST 依後端事件呈現為生效前取消

#### Scenario: 期限已過但尚未收到逾期狀態

- **GIVEN** 等待審批的退款已超過 server 提供的期限，介面尚未收到逾期事件
- **WHEN** 介面呈現該卡片
- **THEN** 介面 MUST 維持等待審批狀態並 MAY 顯示期限已過的提示
- **AND** 使用者送出決定後，狀態 MUST 依 server 回傳的結果呈現

---

### Requirement: 介面不提供 undo affordance

任何介面 MUST NOT 提供撤銷、復原或取消已確認操作的控制項。執行中與已確認的操作 MUST NOT 顯示取消控制項。

#### Scenario: 已確認的操作

- **GIVEN** 一筆退款為 confirmed
- **WHEN** 檢查該操作卡片的可操作元素
- **THEN** MUST NOT 存在撤銷、復原或取消控制項

#### Scenario: 執行中的操作

- **GIVEN** 一筆退款為 executing
- **WHEN** 檢查該操作卡片
- **THEN** MUST NOT 存在取消控制項

---

### Requirement: 未知 card 與無效 payload 安全降級

介面收到未知 card 類型、未知 schema 版本、未知狀態值或驗證失敗的 card payload 時，MUST 以通用安全方式呈現，MUST NOT 中斷串流，MUST NOT 推測其語意。

#### Scenario: 未知 card 類型

- **GIVEN** 串流中出現未知 card 類型
- **WHEN** 介面處理事件
- **THEN** MUST 以通用方式呈現並繼續處理後續事件

#### Scenario: 未知操作狀態

- **GIVEN** 操作狀態事件帶有未知狀態值
- **WHEN** 介面處理
- **THEN** MUST 呈現為狀態未知的通用說明
- **AND** MUST NOT 映射為任何已知狀態
