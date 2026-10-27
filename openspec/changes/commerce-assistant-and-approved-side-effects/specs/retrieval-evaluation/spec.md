## ADDED Requirements

### Requirement: 評測資料集涵蓋商品、訂單與多輪鏈路案例

評測資料集 MUST 以 evaluation case 契約的向後相容 minor 版本新增商品、政策、訂單與多輪案例。新增的預期結果種類 MUST 至少能表達每輪預期意圖、預期引用或拒答，以及預期操作 terminal 狀態。案例 MUST 至少包含：審批拒絕、審批逾期、生效前取消、並行重複提交、提交後回應遺失、商品查詢後接政策問答、以及一題檢索內容聲稱已預先核准的對抗案例。只支援舊版本契約的載入器 MUST 以 typed failure 拒絕新種類案例，MUST NOT 靜默略過。

#### Scenario: 題型分布

- **GIVEN** 擴充後的資料集
- **WHEN** 檢查鏈路案例
- **THEN** MUST 含上述每一種必要案例至少一題
- **AND** 每題 MUST 帶合成資料 provenance 與資料分級

#### Scenario: 舊載入器遇到新種類

- **GIVEN** 只支援舊版契約的載入器
- **WHEN** 載入含新預期結果種類的案例
- **THEN** 該案例 MUST 以 typed failure 被拒絕並列入報表

#### Scenario: 新載入器同時讀取新舊版本

- **GIVEN** 支援新 minor 版本的載入器
- **WHEN** 同時載入舊版本案例與新版本鏈路案例
- **THEN** 兩者 MUST 都被接受，舊版本案例的語意與錯誤碼 MUST 不變
- **AND** 不支援的版本字串 MUST 以可與其他 schema 錯誤區分的 typed failure 拒絕

---

### Requirement: 路由與操作結果逐題計分且誤分流可觀察

評測 MUST 逐題逐輪比對實際路由與預期意圖，並輸出路由準確率與混淆矩陣。誤分流 MUST 計為失敗，MUST NOT 因 fallback 回覆而計為正確。操作案例 MUST 比對實際 terminal 狀態與預期狀態。案例中的人工審批決定 MUST 由評測 harness 以測試 principal 經 resume 送出，MUST NOT 由受測模型產生。deterministic 結果與 live 結果 MUST 分開回報；無法完成的執行 MUST 標記為未完成。

#### Scenario: 誤分流

- **GIVEN** 一題預期為政策問答的案例
- **WHEN** 系統將其路由為商品查詢
- **THEN** 該輪 MUST 計為路由失敗並出現在混淆矩陣

#### Scenario: 操作 terminal 狀態比對

- **GIVEN** 一題預期審批拒絕的案例
- **WHEN** harness 送出拒絕決定
- **THEN** 實際 terminal 狀態 MUST 為審批拒絕才計為正確

#### Scenario: 路由由腳本決定時不計路由準確率

- **GIVEN** deterministic 評測以腳本替身決定路由
- **WHEN** 產出報表
- **THEN** 路由準確率與混淆矩陣 MUST 標示為未量測，MUST NOT 以腳本結果報告為準確率

#### Scenario: 執行中斷

- **GIVEN** 評測中某題因供應商逾時或取消未完成
- **WHEN** 產出報表
- **THEN** 該次執行 MUST 標記為未完成
- **AND** MUST NOT 以成功子集發布分數
