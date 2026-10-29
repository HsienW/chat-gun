# retrieval-evaluation Specification

## Purpose
TBD - created by archiving change governed-knowledge-retrieval-and-evaluation. Update Purpose after archive.
## Requirements
### Requirement: evaluation case 契約版本化且前向相容

evaluation case MUST 具備版本化契約，包含：穩定識別、資料集版本、輸入、預期結果（可回答並列出相關來源，或應拒答）、禁止結果、計分方式、provenance（含合成資料標記）與資料分級。契約 MUST 為後續完整評測平台契約的子集並保持前向相容。未知欄位 MUST 保留，未知預期結果種類 MUST 以 typed failure 拒絕該 case。

#### Scenario: 合法 case 通過驗證

- **GIVEN** 一個欄位完整的 evaluation case
- **WHEN** 載入資料集
- **THEN** 該 case MUST 通過 schema 驗證並納入計分

#### Scenario: 未知預期結果種類

- **GIVEN** 一個預期結果種類不在契約內的 case
- **WHEN** 載入資料集
- **THEN** 該 case MUST 以 typed failure 被拒絕並列入報表
- **AND** MUST NOT 被靜默略過

#### Scenario: 資料集含必要題型

- **GIVEN** 資料集 v1
- **WHEN** 檢查題型分布
- **THEN** MUST 至少含 10 題拒答題與 1 題對抗題
- **AND** dev 與 test split MUST 固定並版本化

---

### Requirement: 檢索指標以 programmatic scorer 計算

系統 MUST 以 programmatic scorer 計算 Recall@5、MRR 與引用準確率。引用準確率 MUST 以引用是否可解析且屬於相關來源判定。

#### Scenario: 計算檢索指標

- **GIVEN** 一組已執行的可回答 case 與其檢索結果
- **WHEN** 執行 scorer
- **THEN** MUST 輸出 Recall@5、MRR 與引用準確率
- **AND** 每個 case 的逐題結果 MUST 可追溯

#### Scenario: 引用不可解析計為錯誤

- **GIVEN** 某回答含無法解析的引用
- **WHEN** 計算引用準確率
- **THEN** 該引用 MUST 計為錯誤

---

### Requirement: 拒答是正確結果並獨立計分

拒答題的正確拒答 MUST 計為正確結果，MUST NOT 因未提供答案而扣分。報表 MUST 同時呈現拒答題的正確拒答率與可回答題的誤拒率。

#### Scenario: 正確拒答

- **GIVEN** 一題預期應拒答的 case
- **WHEN** 系統回傳 no source found 並聲明知識庫未涵蓋
- **THEN** 該 case MUST 計為正確

#### Scenario: 拒答題給出肯定答案

- **GIVEN** 一題預期應拒答的 case
- **WHEN** 系統未聲明來源缺失而給出肯定答案
- **THEN** 該 case MUST 計為失敗，並標記為禁止結果

#### Scenario: 可回答題被誤拒

- **GIVEN** 一題可回答的 case
- **WHEN** 系統回傳 no source found
- **THEN** 該 case MUST 計入誤拒率

---

### Requirement: 模型評分必須附人工抽查紀錄

忠實度等 model-assisted 評分 MUST 記錄評分模型與 prompt 版本。每次發布的評測 MUST 附至少 10 題人工抽查紀錄與一致率。沒有人工抽查紀錄的 model-assisted 分數 MUST NOT 發布。

#### Scenario: 發布前有人工抽查

- **GIVEN** 一次含忠實度評分的評測
- **WHEN** 準備發布結果
- **THEN** MUST 存在至少 10 題的人工抽查紀錄與一致率

#### Scenario: 缺人工抽查

- **GIVEN** 一次缺少人工抽查紀錄的評測
- **WHEN** 嘗試發布忠實度分數
- **THEN** 該分數 MUST 被標記為不可發布

---

### Requirement: 檢索設定對比具可重現 provenance

系統 MUST 能在同一版本化資料集上執行至少「只用 vector」與「vector 加 rerank」兩組設定，並輸出對比表。每份報表 MUST 記錄資料集版本、embedding、rerank 與生成模型識別、prompt 版本、門檻版本、執行次數、日期與合成資料聲明。無法重現的數字 MUST NOT 發布。

#### Scenario: 產出對比表

- **GIVEN** 資料集 v1 與兩組檢索設定
- **WHEN** 執行對比
- **THEN** MUST 輸出兩組設定的 Recall@5、MRR、引用準確率、忠實度與拒答率
- **AND** 報表 MUST 含完整 provenance

#### Scenario: 不完整的執行

- **GIVEN** 評測執行中有 case 因供應商錯誤、逾時或取消未完成
- **WHEN** 產出報表
- **THEN** 該次執行 MUST 標記為未完成
- **AND** MUST NOT 以成功子集計算並發布分數

#### Scenario: live 與 deterministic 分開回報

- **GIVEN** 同時有使用 mock 的 deterministic 測試與使用真實模型的 live 評測
- **WHEN** 產出報表
- **THEN** 兩者 MUST 分開呈現
- **AND** mock 結果 MUST NOT 被標示為 live 結果

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
