## ADDED Requirements

### Requirement: 客戶端 MUST NOT 經 BFF 直接寫入 graph state

BFF MUST 在轉送前拒絕任何會讓客戶端直接寫入 graph state 或跳過 graph 路由的請求，包括：更新 thread state 的請求、建立 thread 時預寫 state 的請求，以及 `command` 含 `resume` 以外欄位（例如 `update`、`goto`）的 run 請求。批次請求中只要有一筆違反，整個請求 MUST 被拒絕。被拒絕的請求 MUST NOT 送達 LangGraph，MUST 回傳可辨識的 typed 錯誤並記錄 audit。只讀取資料的請求（包括以 POST 實作的查詢）、一般 prompt 與取消輸入，以及只含 `resume` 的 `command` MUST 不受影響。

#### Scenario: 拒絕更新 thread state

- **GIVEN** 已登入的客戶端
- **WHEN** 送出更新某 thread state 的請求
- **THEN** BFF MUST 以 typed 錯誤拒絕
- **AND** 請求 MUST NOT 送達 LangGraph，graph state MUST 不變

#### Scenario: 拒絕建立 thread 時預寫 state

- **GIVEN** 已登入的客戶端
- **WHEN** 建立 thread 的請求帶有預寫 state 的內容
- **THEN** BFF MUST 以 typed 錯誤拒絕且不轉送

#### Scenario: 拒絕以 command 改寫 state 或跳轉節點

- **GIVEN** 已登入的客戶端
- **WHEN** 建立 run 的請求在 `command` 中帶有 `update` 或 `goto`，或帶有 `resume` 以外的任何欄位
- **THEN** BFF MUST 以 typed 錯誤拒絕且不轉送
- **AND** 同一請求即使也帶有 `resume` 仍 MUST 被拒絕

#### Scenario: 批次請求中有一筆違反

- **GIVEN** 一個含多筆 run 的批次請求
- **WHEN** 其中任一筆的 `command` 含 `resume` 以外的欄位
- **THEN** 整個批次請求 MUST 被拒絕，MUST NOT 部分轉送

#### Scenario: 只含 resume 的 command 照常轉送

- **GIVEN** 等待審批或澄清的 thread
- **WHEN** 客戶端送出只含 `resume` 的 `command`
- **THEN** BFF MUST 照常轉送，行為與變更前一致

#### Scenario: 讀取請求不受影響

- **GIVEN** 以 POST 實作的唯讀請求（例如查詢 thread 歷史、查詢特定 checkpoint 的 state、搜尋）
- **WHEN** 客戶端送出
- **THEN** BFF MUST 照常轉送

#### Scenario: 一般輸入不受影響

- **GIVEN** 既有 graph 的 prompt 輸入（含 graph 自己的設定欄位）與取消輸入
- **WHEN** 客戶端送出
- **THEN** BFF MUST 照常轉送，回應與錯誤碼與變更前一致

---

### Requirement: `shopping_assistant` 只接受宣告的輸入欄位

`shopping_assistant` MUST 宣告輸入 schema，只接受使用者訊息與取消輸入所需的欄位。審批、工具佇列、操作狀態、事件序號等內部 state MUST NOT 能經 run 輸入寫入。此防線 MUST 在 graph 內成立，不依賴 BFF。

#### Scenario: 輸入夾帶內部 state

- **GIVEN** 一個 `shopping_assistant` thread
- **WHEN** run 輸入除了訊息外，還夾帶審批描述、作用中的 tool call、工具佇列或操作狀態
- **THEN** 這些欄位 MUST NOT 寫入 graph state
- **AND** 後續節點 MUST 只依 server 端產生的 state 判斷

#### Scenario: 一般訊息與取消輸入

- **GIVEN** 一個 `shopping_assistant` thread
- **WHEN** 客戶端送出訊息輸入或取消輸入
- **THEN** graph MUST 照常處理
