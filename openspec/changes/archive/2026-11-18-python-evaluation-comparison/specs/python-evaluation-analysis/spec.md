## ADDED Requirements

### Requirement: 評測產出以版本化模型做 Runtime Validation

Python 評測分析套件 MUST 以版本化的資料模型讀取 kb-eval 與 research-eval 的 run 檔與 provenance 檔。必要欄位缺失、型別錯誤，或封閉集合欄位（狀態、題目類型、split、類別）出現未知值時，MUST 以非零狀態結束，錯誤訊息 MUST 包含檔案路徑與欄位路徑。未知的新增欄位 MUST 被容許且不影響計算。套件 MUST 只讀取使用者指定的 run 目錄，MUST NOT 修改任何輸入檔。

#### Scenario: 合法的 run 檔

- **GIVEN** 一個已錄的 kb-eval run 目錄，含 run 檔與 provenance 檔
- **WHEN** 套件讀取該目錄
- **THEN** 讀取成功，輸入檔內容與修改時間不變

#### Scenario: 必要欄位缺失

- **GIVEN** 一個 run 檔的某題缺少 `latencyMs`
- **WHEN** 套件讀取該檔
- **THEN** 以非零狀態結束，錯誤訊息包含檔名與該題的欄位路徑

#### Scenario: 封閉集合出現未知值

- **GIVEN** 一個 run 檔的某題 `split` 為未知值
- **WHEN** 套件讀取該檔
- **THEN** 以非零狀態結束並指出未知值，不把該題歸入任何既有 split

#### Scenario: 未知的新增欄位

- **GIVEN** 一個 run 檔含有模型未定義的新欄位
- **WHEN** 套件讀取並重算摘要
- **THEN** 讀取成功，計算結果與沒有該欄位時相同

### Requirement: 重算摘要必須與 TS 摘要一致

套件 MUST 由逐題資料獨立重算 run 摘要，並與 run 檔內由 TS 產生的摘要逐項比對。計數類指標與延遲 percentile MUST 完全相同；比率類指標的絕對誤差 MUST NOT 超過 `1e-9`。任一指標不一致時 MUST 以非零狀態結束，並列出評測類型、split、指標名稱、TS 值與 Python 值。指標定義 MUST 以 TS scorer 為唯一來源。比對範圍 MUST 是 TS `summary` JSON 的全部葉節點；TS 只在特定條件下才加入的欄位（例如 research 的 rerank 與 citation guard 摘要），Python MUST 在相同條件下產生、在其他情況下省略，欄位集合不同即視為不一致。全部已錄 run 都 MUST 通過；無法通過的早期 run MUST 列於具名且附原因的例外清單，MUST NOT 以放寬誤差處理。

#### Scenario: 全部已錄 run 一致

- **GIVEN** repo 中全部已錄的 kb-eval 與 research-eval run
- **WHEN** 執行一致性檢查
- **THEN** 每個 run、每個 split、每個指標都一致，程序以零狀態結束

#### Scenario: 摘要被竄改

- **GIVEN** 一個 run 檔的 `summary.test.mrr` 被改成與逐題資料不符的值
- **WHEN** 執行一致性檢查
- **THEN** 以非零狀態結束，輸出 `test`、`mrr`、TS 值與 Python 值

#### Scenario: 浮點加總順序差異

- **GIVEN** Python 與 TS 對同一比率的計算只有小於 `1e-9` 的差異
- **WHEN** 執行一致性檢查
- **THEN** 視為一致

#### Scenario: 條件性欄位

- **GIVEN** 一個沒有 rerank 的 research run，TS `summary` 不含 rerank 摘要
- **WHEN** 重算摘要並比對
- **THEN** Python 摘要同樣不含該欄位，比對通過
- **AND** 若 Python 多產生了該欄位（例如值為 null），比對失敗並指出欄位集合不同

#### Scenario: 空集合

- **GIVEN** 某 split 沒有任何 answerable 題目
- **WHEN** 重算摘要
- **THEN** 該 split 的比率指標與 TS 的空集合處理相同（例如同為 `null` 或同為 0），不拋出除以零錯誤

### Requirement: 跨 run 比較報告

套件 MUST 能以兩個以上同一評測類型的 run 產生比較報告。資料集版本不同時 MUST 拒絕比較並以非零狀態結束，除非使用者以明確選項允許，此時報告 MUST 標示為跨資料集版本比較。報告 MUST 包含各 run 的 provenance 對照（缺少欄位顯示為「未記錄」）、TS `summary` 全部葉節點指標在各 split 的數值與相對基準 run 的差異、每個指標的樣本數，以及小樣本提醒。報告 MUST NOT 包含逐題問題、回答或證據全文。

#### Scenario: 模型比較

- **GIVEN** 兩個同資料集版本的 kb-eval run，生成模型分別為 A 與 B
- **WHEN** 產生比較報告
- **THEN** 報告列出兩者的生成模型、各指標數值與差異、樣本數

#### Scenario: 資料集版本不同

- **GIVEN** 兩個 run 的資料集版本不同
- **WHEN** 未使用允許跨版本的選項而產生比較報告
- **THEN** 以非零狀態結束並指出兩個版本，不產生報告檔

#### Scenario: 舊 run 缺少新 provenance 欄位

- **GIVEN** 一個早期 run 的 provenance 沒有 thinking 與 endpoint 欄位
- **WHEN** 產生比較報告
- **THEN** 這兩個欄位在該 run 顯示為「未記錄」，不推測補值

#### Scenario: 只給一個 run

- **GIVEN** 使用者只指定一個 run
- **WHEN** 產生比較報告
- **THEN** 以非零狀態結束並說明至少需要兩個 run

### Requirement: 離線、deterministic 與原子輸出

套件 MUST NOT 呼叫模型、網路或資料庫，MUST NOT 依賴模型或網路 SDK，MUST NOT 讀取環境 secret 檔。相同輸入 MUST 產生位元組相同的報告；報告 MUST NOT 包含執行當下的時間戳。報告 MUST 先寫入暫存檔再原子性改名；執行中被中斷時 MUST NOT 留下不完整的報告檔。

#### Scenario: 重複執行

- **GIVEN** 相同的輸入 run 與選項
- **WHEN** 連續產生兩次報告
- **THEN** 兩份報告位元組相同

#### Scenario: 執行中被中斷

- **GIVEN** 產生報告的過程中收到中斷訊號
- **WHEN** 程序結束
- **THEN** 目標路徑沒有不完整的報告檔，既有同名檔案保持原內容

#### Scenario: 無網路環境

- **GIVEN** 網路完全不可用
- **WHEN** 執行一致性檢查與比較報告
- **THEN** 兩者行為與有網路時相同

### Requirement: Python 元件有獨立 CI 驗證

repo MUST 提供 Python 套件的 CI 檢查，涵蓋格式與 lint、strict 型別檢查、單元測試與全部已錄 run 的一致性檢查。任一項失敗 MUST 讓該 CI 失敗。Python 套件或評測結果目錄變更時 MUST 觸發此檢查。

#### Scenario: 一致性檢查失敗阻擋合併

- **GIVEN** 一個變更讓某已錄 run 的一致性檢查失敗
- **WHEN** CI 執行
- **THEN** Python CI 失敗並在輸出中列出不一致的指標

#### Scenario: 新增評測結果

- **GIVEN** 一個 PR 新增一個 kb-eval run 目錄
- **WHEN** CI 執行
- **THEN** 該 run 自動納入一致性檢查
