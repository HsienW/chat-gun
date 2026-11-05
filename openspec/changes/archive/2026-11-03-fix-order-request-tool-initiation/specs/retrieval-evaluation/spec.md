## ADDED Requirements

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
