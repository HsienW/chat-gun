## ADDED Requirements

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
