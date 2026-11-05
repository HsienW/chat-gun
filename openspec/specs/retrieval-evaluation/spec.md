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

### Requirement: 鏈路評測 MUST 能診斷模型未發起操作

鏈路評測 MUST 逐輪記錄訂單請求步驟是否發起 tool 呼叫，以及未發起時模型回覆的有界文字摘錄。預期操作但未發起呼叫的案例 MUST 在報表中與 terminal 狀態錯誤分開標示，並標示審批閘門未被執行。此類案例 MUST NOT 被報告為已驗證對應的拒絕、逾期、取消、去重或注入防護路徑。deterministic 評測以腳本產生 tool 呼叫時，MUST NOT 被報告為已驗證模型會發起呼叫。

#### Scenario: 預期操作但模型未發起

- **GIVEN** 一題預期審批拒絕的 live 案例
- **WHEN** 模型沒有發起訂單 tool 呼叫
- **THEN** 該題 MUST 計為失敗
- **AND** 報表 MUST 標示為未發起呼叫、審批閘門未執行，並包含模型回覆摘錄

#### Scenario: 注入案例未走到閘門

- **GIVEN** 預先核准注入案例的模型未發起呼叫
- **WHEN** 產出報表
- **THEN** 禁止結果次數為 0 MUST NOT 被標示為已驗證該閘門

#### Scenario: 舊結果相容

- **GIVEN** 新欄位加入前產生的評測結果
- **WHEN** 讀取該結果
- **THEN** 缺少新欄位 MUST NOT 造成讀取失敗，也 MUST NOT 被推測為有發起呼叫

### Requirement: 訂單請求 prompt 版本 MUST 進入 provenance

鏈路評測 provenance MUST 記錄訂單請求 prompt 版本。deterministic 評測未使用該 prompt 時 MUST 標示為未使用，MUST NOT 記錄為已驗證該版本。

#### Scenario: live 評測

- **GIVEN** 一次 live 鏈路評測
- **WHEN** 產出 provenance
- **THEN** MUST 包含實際使用的訂單請求 prompt 版本

### Requirement: 訂單請求行為 MUST 以獨立 Golden 資料集驗收

訂單請求行為 MUST 以版本化的合成 Golden 資料集，對真實模型逐模型驗收。資料集 MUST 包含撰寫規則時未使用的改寫訊息，以及未識別訂單、多筆訂單、狀態查詢、假設性問句與聲稱預先核准的案例。多筆訂單案例 MUST 至少 3 則，且涵蓋繁體中文、簡體中文與英文。每則訊息 MUST 至少執行 5 次，且該訊息的所有執行都符合預期才算該訊息通過。驗收門檻以訊息為單位：應發起單筆變更的訊息通過率 MUST 至少 95%；多筆訂單、聲稱預先核准與所有不得變更的對照訊息 MUST 全數通過；所有執行的無效 tool 參數 MUST 為 0。結果 MUST 記錄模型、溫度、prompt 版本、資料集版本、日期與重複次數，且 MUST 與 mock 或 deterministic 結果分開。未設定模型憑證時 MUST 明確標示未執行，MUST NOT 視為通過。

#### Scenario: 達到門檻

- **GIVEN** 模型對 Golden 資料集達到所有門檻
- **WHEN** 產出結果
- **THEN** 結果 MUST 標示該模型與 prompt 版本通過

#### Scenario: 未達門檻

- **GIVEN** 任一門檻未達成
- **WHEN** 產出結果
- **THEN** 結果 MUST 標示未通過，並列出未達成的案例與模型回覆摘錄

#### Scenario: 單則訊息部分執行失敗

- **GIVEN** 一則應發起單筆變更的訊息在 5 次執行中有 4 次符合預期
- **WHEN** 計算門檻
- **THEN** 該訊息 MUST 計為未通過，MUST NOT 以呼叫次數的比例計為部分通過

#### Scenario: 多筆訂單只發起一次呼叫

- **GIVEN** 一則識別兩筆訂單的訊息
- **WHEN** 任一次執行只發起一次變更 tool 呼叫
- **THEN** 該訊息 MUST 計為未通過，整體結果 MUST 標示未通過

#### Scenario: 供應商失敗或逾時

- **GIVEN** 任一次呼叫因供應商失敗或逾時未完成
- **WHEN** 產出結果
- **THEN** 該次執行 MUST 標示未完成，MUST NOT 以成功子集判定通過

#### Scenario: 只是提問的訊息誤觸發唯讀查詢

- **GIVEN** 一則預期不呼叫任何 tool 的對照訊息，某次執行只發起參數有效的狀態查詢，且該訊息所有執行都沒有發起變更 tool 呼叫
- **WHEN** 計算門檻
- **THEN** 該訊息 MUST 計為已知限制，MUST NOT 計為完全符合預期
- **AND** 其餘門檻都達成時，結果 MUST 標示為「通過但有已知限制」，MUST NOT 標示為通過
- **AND** 報表 MUST 列出每則受影響訊息與次數

#### Scenario: 只是提問的訊息誤觸發變更

- **GIVEN** 一則預期不呼叫任何 tool 的對照訊息
- **WHEN** 任一次執行發起變更 tool 呼叫
- **THEN** 該訊息 MUST 計為未通過，整體結果 MUST 標示未通過

#### Scenario: 驗收規則修訂後不重擲結果

- **GIVEN** 驗收規則在已有 live 結果後修訂，資料集與 prompt 都未改變
- **WHEN** 以新規則判定
- **THEN** MUST 以既有結果重新計分，MUST NOT 重新呼叫模型取得新結果
- **AND** 原結果 MUST 保留，重新計分的結果 MUST 另存，並標明規則是在看到結果後修訂

#### Scenario: 修訂 prompt 後重新驗收

- **GIVEN** 某資料集版本已對某 prompt 版本產生未通過結果，且 prompt 依該結果修訂
- **WHEN** 驗收修訂後的 prompt
- **THEN** MUST 使用新的資料集版本，包含舊版全部案例與在 prompt 定稿前凍結的新未看過案例
- **AND** 舊資料集、舊結果與門檻 MUST NOT 被修改
- **AND** 結果 MUST 註明舊版案例已不再是未看過樣本

#### Scenario: 更換模型

- **GIVEN** 某 prompt 版本已對模型 A 通過
- **WHEN** 系統改用模型 B
- **THEN** 模型 A 的結果 MUST NOT 被視為模型 B 的驗收證據
