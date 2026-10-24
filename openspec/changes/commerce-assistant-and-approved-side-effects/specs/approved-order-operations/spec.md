## ADDED Requirements

### Requirement: 訂單 tool 以完整 manifest 宣告且 input 不接受身分或審批欄位

退款申請與訂單取消 tool MUST 以完整 manifest 宣告：external mutation side-effect class、明示 authorization action、in-process 執行 profile 且無外連、以 business effect key 表達的冪等契約、需要人工審批的 approval policy key、只可 reconcile 不可補償的 compensation 宣告與資料分級。訂單狀態查詢 tool MUST 宣告為唯讀。所有訂單 tool 的 input MUST 拒絕 tenant、principal、scope 與任何審批欄位。

#### Scenario: 註冊成功

- **GIVEN** 三個訂單 tool 的 manifest 欄位完整
- **WHEN** 註冊
- **THEN** 註冊 MUST 成功，且 manifest 證據 MUST 記錄 tool 識別、版本與資料分級

#### Scenario: manifest 缺欄位

- **GIVEN** 退款 tool manifest 缺少 approval policy key 或冪等契約
- **WHEN** 註冊
- **THEN** 註冊 MUST fail-closed

#### Scenario: input 夾帶身分或審批欄位

- **GIVEN** 模型輸出的退款參數含 tenant、principal 或 approved 欄位
- **WHEN** dispatch 驗證 input
- **THEN** MUST 以 schema error 拒絕
- **AND** MUST NOT 建立審批請求或呼叫訂單系統

---

### Requirement: 訂單變更只在 durable 人工審批後執行

訂單變更 MUST 在執行前建立 durable 審批請求並等待人工決定。審批 MUST 只能由經 trusted identity 的 resume 記錄，且 MUST 一次性消費。模型輸出 MAY 請求審批，MUST NOT 記錄審批。核准、拒絕與逾期 MUST 產生不同的 terminal 結果；拒絕與逾期時 MUST NOT 呼叫訂單系統。逾期 MUST 由 server 判定：resume 與撤回遇到已超過期限的等待中審批時，MUST 將其轉為逾期；唯讀的狀態查詢讀到已超過期限的等待中審批時，MUST 回報為逾期，且 MUST NOT 寫入任何狀態。

#### Scenario: 核准後執行

- **GIVEN** 一筆退款申請處於等待審批
- **WHEN** 使用者經介面核准
- **THEN** 操作 MUST 依序進入已核准與執行中
- **AND** 訂單系統 MUST 只被呼叫一次

#### Scenario: 審批拒絕

- **GIVEN** 一筆退款申請處於等待審批
- **WHEN** 使用者拒絕
- **THEN** 操作 MUST 以審批拒絕結束
- **AND** 訂單系統 MUST NOT 收到請求，ledger MUST NOT 有任何 claim

#### Scenario: 審批逾期

- **GIVEN** 一筆退款申請在審批期限內未被決定
- **WHEN** 期限過後收到核准 resume
- **THEN** 操作 MUST 以審批逾期結束，且與審批拒絕可區分
- **AND** 訂單系統 MUST NOT 收到請求

#### Scenario: 狀態查詢回報逾期但不寫入

- **GIVEN** 一筆審批已超過期限，但尚未收到任何 resume
- **WHEN** 使用者查詢該操作狀態
- **THEN** 查詢結果 MUST 為審批逾期，而非等待審批
- **AND** 查詢 MUST NOT 修改審批紀錄；之後送出的核准 resume MUST 仍被判定為逾期

#### Scenario: 重放已消費的審批

- **GIVEN** 某審批已被消費
- **WHEN** 再次送出相同的 resume
- **THEN** MUST 回傳 typed replay 或 expired failure
- **AND** MUST NOT 再次執行訂單變更

#### Scenario: 等待審批時中斷恢復

- **GIVEN** 一筆退款申請處於等待審批且服務重新啟動
- **WHEN** 使用者重新開啟對話
- **THEN** 該審批 MUST 仍可辨識為等待中並可被決定
- **AND** 恢復過程 MUST NOT 重複建立審批或呼叫訂單系統

---

### Requirement: 冪等鍵識別邏輯業務操作且並行重複只提交一次

訂單變更的 business effect key MUST 由操作種類、server 端的申請者 principal、訂單識別與正規化的操作明細推導，MUST NOT 包含 attempt、tool call 識別、run 識別或自由文字理由。同一申請者在同一 trusted scope 內的同一邏輯操作 MUST 至多提交一次。第二次提交 MUST 可觀察為去重，並指向原操作，MUST NOT 被呈現為失敗。去重 MUST NOT 跨申請者發生，非擁有者的申請 MUST NOT 得到他人操作的任何資訊。

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

---

### Requirement: 取消只在生效前有效

使用者在等待審批或已核准但尚未進入執行時取消，操作 MUST 以生效前取消結束，且 ledger MUST NOT 有 claim。等待審批時的取消 MUST 經既有取消輸入送達對話流程，且在 interaction governance 未啟用或已啟用時都 MUST 送達。流程 MUST 只依伺服器端保存的審批資訊決定撤回對象，客戶端提供的識別 MUST NOT 作為授權依據；撤回 MUST 綁定審批識別、決策識別、tenant、scope 與允許的審批人，MUST NOT 要求與原 run 相同。撤回後原審批 MUST NOT 能再被核准或執行。撤回 MUST 與審批拒絕可區分，且區分方式 MUST 不讓部署期間仍在運作的舊版 runtime 讀取失敗或把撤回的審批視為可消費。撤回寫入失敗時 MUST 回報 typed failure 並保留可重試取消的狀態，該操作 MUST NOT 執行。執行中收到的取消 MUST NOT 中止已送出的效果，操作 MUST 繼續收斂為確認或未知結果，MUST NOT 呈現為已取消。

#### Scenario: 等待審批時取消

- **GIVEN** 一筆退款申請處於等待審批
- **WHEN** 使用者取消
- **THEN** 該審批 MUST 轉為已撤回，操作 MUST 以生效前取消結束
- **AND** 訂單系統 MUST NOT 收到請求

#### Scenario: 撤回後再送出核准

- **GIVEN** 一筆審批已被撤回
- **WHEN** 再送出核准 resume
- **THEN** MUST 回傳 typed replay 或 expired failure，或因對話中已沒有等待中的審批而不執行任何操作
- **AND** MUST NOT 執行訂單變更

#### Scenario: 撤回寫入失敗

- **GIVEN** 等待審批時使用者取消，但審批儲存無法寫入
- **WHEN** 流程處理取消
- **THEN** MUST 回報 typed 撤回失敗，操作狀態 MUST 維持等待審批，且 MUST 允許再次取消
- **AND** 該操作 MUST NOT 被執行，訂單系統 MUST NOT 收到請求

#### Scenario: 舊版 runtime 讀取已撤回的審批

- **GIVEN** 新版 runtime 已撤回某審批
- **WHEN** 舊版 runtime 收到該審批的核准 resume
- **THEN** 舊版 runtime MUST NOT 因讀取該審批而失敗
- **AND** MUST NOT 消費該審批或執行訂單變更

#### Scenario: 沒有等待中的審批時取消

- **GIVEN** 對話中沒有等待審批的訂單操作
- **WHEN** 使用者送出取消
- **THEN** 流程 MUST 回覆目前沒有可取消的申請
- **AND** MUST NOT 寫入任何審批或 ledger 狀態

#### Scenario: 取消指向其他 run

- **GIVEN** 對話中有等待審批的訂單操作
- **WHEN** 取消輸入指定的 run 與該審批所屬的 run 不同
- **THEN** 流程 MUST NOT 撤回該審批
- **AND** 審批 MUST 仍可被決定

#### Scenario: interaction governance 啟用時取消

- **GIVEN** interaction governance 已啟用，且對話中有等待審批的訂單操作
- **WHEN** 使用者送出取消
- **THEN** 取消 MUST 送達對話流程並撤回該審批
- **AND** 其他對話流程的取消行為 MUST 不變

#### Scenario: 撤回時審批已被決定

- **GIVEN** 一筆審批已被核准或拒絕
- **WHEN** 使用者送出取消
- **THEN** 撤回 MUST 回傳 typed「已決定」結果
- **AND** 操作狀態 MUST 依既有決定前進，MUST NOT 被改為生效前取消

#### Scenario: 已核准但尚未執行時取消

- **GIVEN** 一筆退款已核准但尚未取得 ledger claim
- **WHEN** 使用者取消
- **THEN** 操作 MUST 以生效前取消結束
- **AND** ledger MUST NOT 有 claim，訂單系統 MUST NOT 收到請求

#### Scenario: 已取得 claim 但尚未送出時取消

- **GIVEN** 一筆退款已核准並取得 ledger claim，尚未送往訂單系統
- **WHEN** 使用者取消
- **THEN** 操作 MUST 以生效前取消結束，claim MUST 被釋放
- **AND** 訂單系統 MUST NOT 收到請求，使用者之後 MAY 重新申請並重新審批

#### Scenario: 執行中取消

- **GIVEN** 一筆已核准的退款已送往訂單系統
- **WHEN** 使用者取消
- **THEN** 操作 MUST 維持執行中直到收斂為確認或未知結果
- **AND** 操作 MUST NOT 以任何取消狀態結束

---

### Requirement: 未知結果進入 reconciliation，不盲目重試也不回報成功或失敗

送出後逾時、失去回應或提交後持久化不確定時，系統 MUST 先以 tool 宣告的 reconciliation 方法查詢訂單系統。查詢確定已提交時 MUST 回報確認；確定未提交時 MUST 回報失敗且 MUST NOT 自動重試；仍無法判定時 MUST 進入未知結果並建立 durable reconciliation task。同一 business effect MUST 至多一筆 open reconciliation task。reconciliation task 建立失敗時操作 MUST 仍為未知結果並發出 audit，MUST NOT 回報成功或失敗。

#### Scenario: 回應遺失但已提交

- **GIVEN** 訂單系統已提交退款但回應在傳輸中遺失
- **WHEN** reconciliation 查詢確認已提交
- **THEN** 操作 MUST 以確認結束，並標記結果來自 reconciliation
- **AND** 訂單系統 MUST NOT 被再次呼叫提交

#### Scenario: 回應遺失且無法判定

- **GIVEN** 提交後回應遺失，且 reconciliation 查詢也無法判定
- **WHEN** 執行結束
- **THEN** 操作 MUST 為未知結果，並建立一筆 open reconciliation task
- **AND** 系統 MUST NOT 重試提交，MUST NOT 回報成功或失敗

#### Scenario: 確定未提交

- **GIVEN** 提交後逾時，reconciliation 查詢確定訂單系統未提交
- **WHEN** 執行結束
- **THEN** 操作 MUST 以失敗結束，原因為未提交
- **AND** MUST NOT 自動重試，claim MUST 被釋放以便使用者重新申請

#### Scenario: 重複建立 reconciliation task

- **GIVEN** 某 business effect 已有 open reconciliation task
- **WHEN** 同一 business effect 再次判定為未知結果
- **THEN** MUST NOT 建立第二筆 open task

#### Scenario: reconciliation task 持久化失敗

- **GIVEN** reconciliation task 儲存無法寫入
- **WHEN** 操作判定為未知結果
- **THEN** 操作 MUST 仍呈現為未知結果
- **AND** MUST 發出 typed task 持久化失敗的 audit

---

### Requirement: 訂單 tool 失敗分類穩定且不洩漏他人訂單

訂單 tool MUST 以穩定的 typed failure 區分輸入錯誤、查無訂單、不符資格、操作已存在、dispatch 前 provider 不可用與 dispatch 後 provider 逾時。不屬於目前 tenant 與 principal 的訂單 MUST 與查無訂單回傳相同結果。provider error MUST NOT 被轉為查無訂單。

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

---

### Requirement: 每個已提交效果都有 ledger 紀錄

每個確認的訂單變更 MUST 在 side-effect ledger 留下一筆已提交的 business effect，含 tenant、scope、business effect key、訂單系統的操作識別與審批決策參照。

#### Scenario: 確認後的 ledger 紀錄

- **GIVEN** 一筆退款已確認
- **WHEN** 查詢 ledger
- **THEN** MUST 存在一筆已提交的 business effect，並連結審批決策與訂單系統的操作識別

---

### Requirement: 訂單狀態查詢只讀取權威狀態

訂單狀態查詢 MUST 從 ledger、審批決策與 reconciliation task 讀取目前狀態，MUST NOT 從助理先前文字重建操作狀態或歷史，且 MUST 只回傳目前 tenant 與 principal 的操作。

#### Scenario: 查詢自己的操作

- **GIVEN** 使用者有一筆未知結果的退款
- **WHEN** 使用者在後續一輪詢問退款狀態
- **THEN** 回覆 MUST 以查詢結果呈現未知結果與 reconciliation task 識別

#### Scenario: 查詢他人操作

- **GIVEN** 操作識別屬於另一個 principal
- **WHEN** 查詢狀態
- **THEN** MUST 回傳 typed not found

---

### Requirement: 操作識別從申請起即存在且可連結至 ledger

每筆訂單變更 MUST 自模型產生 tool call 起即有穩定的 tool call 參照，replay 與 resume 時 MUST 不變。同一則模型訊息含多個訂單 tool call 時，每個 MUST 是獨立操作，各自有審批與狀態。訂單 tool 的輸出 MUST 只含效果事實，操作識別與狀態 MUST 由對話流程組成。建立審批後 MUST 有 durable 操作識別，且 MUST 可經審批決策連結至 dispatch 後的 business effect。審批前與審批中的狀態 MUST 能以操作識別查詢，MUST NOT 依賴 dispatch 後才產生的識別。

#### Scenario: 審批中查詢

- **GIVEN** 一筆退款處於等待審批，尚未 dispatch
- **WHEN** 以操作識別查詢狀態
- **THEN** MUST 回傳等待審批

#### Scenario: 確認後連結

- **GIVEN** 一筆退款已確認
- **WHEN** 以操作識別查詢
- **THEN** 結果 MUST 連結至對應的 business effect 與訂單系統操作識別

#### Scenario: 同一則訊息含兩筆訂單操作

- **GIVEN** 模型在同一則訊息中請求兩筆不同訂單的退款
- **WHEN** 流程處理這兩個 tool call
- **THEN** MUST 產生兩個獨立操作，各自有審批與狀態
- **AND** 任一操作的狀態 MUST NOT 覆蓋另一個

#### Scenario: resume 後參照不變

- **GIVEN** 一筆退款在等待審批時服務重新啟動
- **WHEN** 恢復並核准
- **THEN** 前後發出的狀態事件 MUST 使用相同的 tool call 參照與操作識別

---

### Requirement: 不提供 undo 或補償

本能力 MUST NOT 提供任何撤銷、復原或補償已確認操作的路徑。生效前取消與補償 MUST 為不同概念，只有生效前取消可用。

#### Scenario: 已確認的退款要求撤銷

- **GIVEN** 一筆退款已確認
- **WHEN** 使用者要求撤銷該退款
- **THEN** 系統 MUST NOT 呼叫任何補償或撤銷操作
- **AND** 回覆 MUST 說明目前不支援撤銷已確認的操作
