## ADDED Requirements

### Requirement: 去重結果 MUST 在 governed outcome 中可觀察

當 side-effect 執行重用已提交的 business effect 結果，或因同一 business effect 正在進行或結果未知而未取得 claim 時，governed tool outcome MUST 以共用 harness 契約中專屬的去重結果類型表達，至少包含去重原因與原 business effect 參照；重用已提交結果時 MUST 一併帶回原結果。去重原因 MUST 區分「重用已提交結果」「原操作進行中」「原操作結果未知」。去重 MUST NOT 被映射為一般成功、一般失敗或 dispatch 前拒絕。去重時 MUST NOT 再次呼叫外部系統。未取得 claim 的重複提交所留下的執行紀錄 MUST 可與已 dispatch 但結果未知的執行區分，MUST NOT 觸發 reconciliation 或建立 reconciliation task；同一 replay key 重播時 MUST 依原 business effect 的目前狀態決定去重結果。原 business effect 已釋放時 MUST NOT 判定為去重。去重結果類型 MUST 只由明確選擇接收的 dispatch 來源取得；未選擇接收的既有呼叫者 MUST 得到與變更前相同的結果與錯誤碼。去重 MUST NOT 被計為 circuit breaker 的失敗。

#### Scenario: 重用已提交結果

- **GIVEN** 某 business effect 已提交，且結果可重用
- **WHEN** 另一個 logical tool call 以相同 business effect key 執行，且 dispatch 來源選擇接收去重結果
- **THEN** outcome MUST 為去重，原因為重用已提交結果，附原 business effect 參照與原結果
- **AND** 外部系統 MUST NOT 被再次呼叫

#### Scenario: 並行重複且原操作進行中

- **GIVEN** 某 business effect 已被另一次執行 claim 且尚未提交
- **WHEN** 相同 business effect key 的第二次執行到達
- **THEN** outcome MUST 為去重且標記為進行中重複，附原 business effect 參照
- **AND** outcome MUST NOT 為 dispatch 前拒絕或一般失敗，外部系統 MUST NOT 被呼叫

#### Scenario: 進行中重複的提交被重播

- **GIVEN** 某次提交因原 business effect 進行中而得到進行中重複的去重結果
- **WHEN** 該提交的同一 replay key 因 checkpoint 恢復而重播
- **THEN** outcome MUST 依原 business effect 的目前狀態回傳去重結果：已提交為重用已提交結果、仍在進行為原操作進行中、結果未知為原操作結果未知
- **AND** MUST NOT 回傳需要 reconciliation 或未知結果，MUST NOT 建立 reconciliation task

#### Scenario: 同一 replay 但 request 不一致

- **GIVEN** 同一 replay key 已有執行紀錄
- **WHEN** 以不同 request hash 再次執行
- **THEN** outcome MUST 仍為既有的 replay conflict
- **AND** MUST NOT 被標記為去重

#### Scenario: 既有 graph 不受影響

- **GIVEN** 既有 graph 使用唯讀 tool，或其 dispatch 來源未選擇接收去重結果
- **WHEN** 執行既有 tool 流程，包含重用已提交結果與進行中重複
- **THEN** 其結果形狀與錯誤碼 MUST 與變更前一致：重用已提交結果為一般成功並帶原結果，進行中重複為既有的 dispatch 前拒絕錯誤碼

#### Scenario: 去重不觸發 circuit breaker

- **GIVEN** 某 tool 連續得到去重結果
- **WHEN** circuit breaker 記錄結果
- **THEN** 去重 MUST NOT 被計為失敗，MUST NOT 使 circuit 開啟

#### Scenario: 無法處理去重結果類型的消費者

- **GIVEN** 某消費者對 governed outcome 做窮舉處理，且尚未處理去重結果類型
- **WHEN** 收到去重結果
- **THEN** 消費者 MUST fail-closed，MUST NOT 把去重當作成功或靜默忽略

#### Scenario: ledger 不可用

- **GIVEN** side-effect ledger 無法連線
- **WHEN** 執行 side-effect tool
- **THEN** outcome MUST fail-closed 為 ledger 不可用
- **AND** MUST NOT 被標記為去重或成功

---

### Requirement: 確定未提交即結束的執行 MUST 釋放 business effect claim

執行在取得 claim 後，若以確定未提交的結果結束（授權拒絕、dispatch 前拒絕、dispatch 前取消、tool 回報未提交，或 reconciliation 確認未提交），系統 MUST 在單一集中出口將該 business effect 轉為已釋放，並將持有 claim 的執行轉為失敗。結果未知、已提交或持久化不確定時 MUST NOT 釋放。之後同一 business effect key 的新提交 MUST 能以 compare-and-set 重新占用已釋放的效果，並行的重新占用 MUST 只有一個成功。重新占用 MUST 只由新的、已重新授權的提交觸發，MUST NOT 成為自動重試。

#### Scenario: 未提交失敗後重新提交

- **GIVEN** 某次執行取得 claim 後，tool 回報未提交的失敗
- **WHEN** 之後同一 key 的新提交經授權後執行
- **THEN** 原 business effect MUST 已為已釋放，新提交 MUST 重新占用並執行一次
- **AND** MUST NOT 被判定為進行中重複

#### Scenario: 已取得 claim 但尚未 dispatch 時取消

- **GIVEN** 某次執行已取得 claim、尚未呼叫外部系統
- **WHEN** 執行被取消
- **THEN** business effect MUST 被釋放，結果 MUST 為 dispatch 前取消
- **AND** 外部系統 MUST NOT 被呼叫

#### Scenario: 結果未知不釋放

- **GIVEN** 某次執行已呼叫外部系統且結果無法判定
- **WHEN** 執行結束
- **THEN** business effect MUST NOT 被釋放，MUST 進入未知結果
- **AND** 之後同一 key 的提交 MUST NOT 重新占用該效果

#### Scenario: reconciliation 確認未提交

- **GIVEN** 某次執行結果未知，reconciliation 確認外部系統未提交
- **WHEN** reconciliation 完成
- **THEN** 結果 MUST 為未提交的失敗且 MUST NOT 自動重試
- **AND** business effect MUST 被釋放

#### Scenario: 並行重新占用

- **GIVEN** 某 business effect 已釋放
- **WHEN** 同一 key 的兩個新提交並行執行
- **THEN** MUST 只有一個重新占用成功並呼叫外部系統
- **AND** 另一個 MUST 得到進行中重複的去重結果

#### Scenario: 釋放寫入失敗

- **GIVEN** 某次執行以確定未提交的結果結束（例如 tool 回報訂單不存在，或 dispatch 前取消）
- **WHEN** 釋放 business effect 的寫入失敗
- **THEN** 結果 MUST NOT 為一般的未提交失敗或取消，MUST 為持久化不確定
- **AND** 開啟 reconciliation task 的來源 MUST 建立 reconciliation task
- **AND** MUST NOT 重新 dispatch，MUST NOT 自動重試

#### Scenario: 執行逾時但確定未 dispatch

- **GIVEN** 某次執行在呼叫外部系統之前因逾時而結束
- **WHEN** 執行結束
- **THEN** business effect MUST 被釋放，結果 MUST 為未提交的失敗

---

### Requirement: 已預先完成的授權 MUST 攜帶已消費的決策識別

授權已在 dispatch 前完成（例如經人工審批）時，dispatch MUST 攜帶該次已消費授權決策的識別，執行紀錄 MUST 連結該識別。決策識別 MUST 只來自 server 端已消費的授權紀錄，MUST NOT 來自模型輸出、tool input 或客戶端可提供的設定。有副作用的 dispatch 在取得 claim 之前 MUST 以 server 端紀錄驗證該識別：決策必須存在且為允許、屬於本次執行的 principal 與 scope、屬於本次 tool；若來自人工審批，必須已核准、已消費且屬於本次 tool call。缺少或無法驗證決策識別時 MUST 在取得 claim 之前以 typed failure 拒絕，MUST NOT 留下 claim。

#### Scenario: 審批後執行

- **GIVEN** 某 side-effect 呼叫已經人工審批並消費
- **WHEN** dispatch 執行
- **THEN** 執行 MUST 成功取得 claim 並呼叫外部系統
- **AND** 執行紀錄 MUST 連結已消費的決策識別

#### Scenario: 缺少決策識別

- **GIVEN** dispatch 宣告授權已預先完成，但沒有決策識別
- **WHEN** 執行
- **THEN** MUST 在取得 claim 前以 typed failure 拒絕
- **AND** ledger MUST NOT 有新的 claim，外部系統 MUST NOT 被呼叫

#### Scenario: 偽造或挪用的決策識別

- **GIVEN** dispatch 帶有一個不存在、屬於其他 principal 或 scope、屬於其他 tool 或 tool call、尚未核准或已撤回的決策識別
- **WHEN** 有副作用的 tool 執行
- **THEN** MUST 在取得 claim 前以 typed failure 拒絕並記錄 audit
- **AND** ledger MUST NOT 有新的 claim，外部系統 MUST NOT 被呼叫

#### Scenario: 客戶端設定中夾帶決策識別

- **GIVEN** 客戶端在 run 設定中放入決策識別
- **WHEN** 預先授權的 dispatch 執行
- **THEN** 該值 MUST NOT 被採用

#### Scenario: 取消發生在 claim 之前

- **GIVEN** 已審批的呼叫在取得 claim 前收到中止訊號
- **WHEN** 執行
- **THEN** MUST 在 claim 前結束為 dispatch 前取消
- **AND** ledger MUST NOT 有新的 claim

---

### Requirement: 已釋放與未取得 claim 的表達 MUST 與舊版 runtime 並存

已釋放的 business effect 與未取得 claim 的執行紀錄 MUST 以新增欄位表達，既有狀態欄位 MUST 只寫入既有值。支援這些表達的 schema 變更 MUST 只新增欄位或資料表。部署期間仍在運作的舊版 runtime 讀取這些紀錄時 MUST NOT 失敗，且 MUST NOT 因此重複呼叫外部系統。

#### Scenario: 舊版 runtime 讀取已釋放的效果

- **GIVEN** 新版 runtime 已將某 business effect 釋放
- **WHEN** 舊版 runtime 以相同 key 處理新的提交
- **THEN** 舊版 runtime MUST NOT 因讀取該效果而失敗
- **AND** 外部系統 MUST NOT 被重複呼叫

#### Scenario: 舊版 runtime 讀取未取得 claim 的執行紀錄

- **GIVEN** 新版 runtime 為未取得 claim 的提交寫入了執行紀錄
- **WHEN** 舊版 runtime 進行取消判定或重播
- **THEN** 舊版 runtime MUST NOT 因該紀錄失敗
- **AND** MUST NOT 將該紀錄判定為已提交

#### Scenario: migration 只新增

- **GIVEN** 支援已釋放與未取得 claim 表達的 migration
- **WHEN** 執行 additive migration 檢查
- **THEN** 檢查 MUST 通過，migration MUST NOT 移除或改名既有欄位與 constraint

---

### Requirement: 同時寫入 business effect 與執行紀錄的路徑 MUST 以一致順序加鎖

提交、釋放與重新占用在同一交易中同時寫入 business effect 與執行紀錄時，MUST 以相同順序取得鎖：先 business effect，再執行紀錄。

#### Scenario: 提交、釋放與重新占用並行

- **GIVEN** 同一 business effect 上有提交、釋放或重新占用並行發生
- **WHEN** 各交易執行
- **THEN** MUST NOT 發生資料庫死鎖
- **AND** 每個狀態轉移 MUST 只有一個成功，其餘依新狀態得到明確結果
