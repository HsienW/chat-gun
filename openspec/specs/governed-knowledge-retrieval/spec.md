# governed-knowledge-retrieval Specification

## Purpose
TBD - created by archiving change governed-knowledge-retrieval-and-evaluation. Update Purpose after archive.
## Requirements
### Requirement: 知識庫為與 orchestration store 分離的衍生索引，且每個 chunk 具備 provenance

系統 MUST 以與 orchestration checkpoint 及 runtime persistence 分離的儲存保存知識庫。知識庫 MUST 被視為由來源文件衍生的非權威索引。每個 chunk MUST 記錄 tenant、來源文件識別、來源版本、在來源中的位置、資料分級、所屬 ingestion run 與 embedding space。

#### Scenario: chunk 具備完整 provenance

- **GIVEN** 一份帶有合成資料 provenance 標記的來源文件已完成入庫
- **WHEN** 讀取其任一 chunk
- **THEN** 該 chunk MUST 具備 tenant、來源識別、來源版本、位置、資料分級、ingestion run 與 embedding space
- **AND** 缺任一欄位的 chunk MUST NOT 可被查詢

#### Scenario: 缺 provenance 標記的來源被拒絕

- **GIVEN** 一份未帶合成資料或來源 provenance 標記的文件
- **WHEN** 提交入庫
- **THEN** 系統 MUST 以 typed failure 拒絕該文件
- **AND** MUST NOT 產生任何 chunk

#### Scenario: 知識庫不可用時不影響既有對話

- **GIVEN** 知識庫服務無法連線
- **WHEN** 一般對話不需要知識檢索
- **THEN** 既有對話流程 MUST 正常完成
- **AND** 需要知識檢索的請求 MUST 收到 typed failure，而非無聲的空結果

---

### Requirement: 入庫冪等且可續跑

入庫 MUST 以來源識別、來源版本、chunk 序號、內容雜湊與 embedding space 作為自然鍵。重複提交同一來源版本 MUST 不產生重複 chunk 或重複嵌入。中斷後重新執行 MUST 跳過已完成的 chunk。部分失敗時 ingestion run MUST 標記為未完成，且 MUST NOT 將部分嵌入的文件標記為完成。

#### Scenario: 重複提交為 no-op

- **GIVEN** 某來源版本已完成入庫
- **WHEN** 再次提交相同來源版本
- **THEN** 系統 MUST NOT 呼叫 embedding
- **AND** chunk 數量 MUST 不變

#### Scenario: 中斷後續跑

- **GIVEN** 一次入庫在部分批次完成後中斷
- **WHEN** 重新執行同一入庫
- **THEN** 已完成的 chunk MUST 被跳過
- **AND** 最終 chunk 集合 MUST 與未中斷時一致

#### Scenario: 部分批次失敗

- **GIVEN** embedding 供應商對某批次回傳錯誤或逾時
- **WHEN** 入庫結束
- **THEN** ingestion run MUST 為未完成狀態並記錄 typed 失敗原因
- **AND** 受影響文件 MUST NOT 被標記為已完成
- **AND** 已成功的 chunk MUST 保持一致且可續跑

#### Scenario: 超大或空內容文件

- **GIVEN** 一份超過大小上限或擷取後為空的文件
- **WHEN** 提交入庫
- **THEN** 系統 MUST 回傳對應的 typed failure
- **AND** MUST NOT 影響同一 run 中其他文件的處理

---

### Requirement: embedding 與 rerank 只經受治理的模型閘道呼叫

embedding 與 rerank 呼叫 MUST 經由模型閘道，以宣告的 capability 判定是否支援。供應商憑證 MUST 只在執行邊界經 secret broker 解析，MUST NOT 由 tool、graph 節點或入庫程序直接讀取。外連目的地 MUST 經 egress policy 判定，含 redirect。每次呼叫 MUST 發出可供後續計量消費的用量事件。既有 chat 用途的行為 MUST 不變。

#### Scenario: 成功嵌入並發出用量事件

- **GIVEN** 已設定支援 embedding 的模型與可解析的 secret reference
- **WHEN** 入庫或查詢請求 embedding
- **THEN** 閘道 MUST 回傳向量
- **AND** MUST 發出含 provider、model、purpose、用量、延遲、結果與 correlation 識別的用量事件

#### Scenario: 未宣告能力的 provider

- **GIVEN** 一個未宣告 embedding 或 rerank 能力的 provider 設定
- **WHEN** 以該用途呼叫
- **THEN** 閘道 MUST 回傳 typed unsupported failure
- **AND** MUST NOT 發出外部請求

#### Scenario: 憑證不可解析或 egress 被拒

- **GIVEN** secret reference 無法解析，或目的地不在 egress 允許清單
- **WHEN** 請求 embedding 或 rerank
- **THEN** 閘道 MUST 回傳對應的 typed failure
- **AND** MUST NOT 以環境變數或其他路徑取得憑證

#### Scenario: 供應商逾時或限流

- **GIVEN** 供應商逾時或回傳限流
- **WHEN** 呼叫 embedding
- **THEN** 閘道 MUST 依既有 resilience policy 退避或回傳 typed failure
- **AND** MUST NOT 無上限重試

#### Scenario: 呼叫被取消

- **GIVEN** 一個進行中的 embedding 或 rerank 呼叫
- **WHEN** 上游請求被取消
- **THEN** 閘道 MUST 中止該呼叫並回傳取消結果
- **AND** MUST NOT 將取消回報為成功或一般錯誤

#### Scenario: 既有 chat 用途不受影響

- **GIVEN** 新增 embedding 與 rerank 用途
- **WHEN** 執行既有 chat、math、research、vision 與 tool 用途
- **THEN** 其行為與設定 MUST 與變更前一致

---

### Requirement: embedding space 版本化且不一致時 fail-closed

embedding 模型識別與維度 MUST 為版本化設定。查詢向量與索引的 embedding space 不一致時 MUST 回傳 typed failure，MUST NOT 靜默比對。模型或維度變更 MUST 透過建立新 embedding space 並重新索引完成。

#### Scenario: 維度不一致

- **GIVEN** 索引建立於某 embedding space
- **WHEN** 查詢使用不同模型或維度的 embedding
- **THEN** 系統 MUST 回傳 typed dimension／space mismatch failure
- **AND** MUST NOT 回傳任何檢索結果

#### Scenario: 切換模型需要重新索引

- **GIVEN** 設定切換為新的 embedding 模型
- **WHEN** 尚未完成新 embedding space 的入庫
- **THEN** 查詢 MUST 繼續使用既有已完成的 embedding space，或明確回傳 not-ready failure
- **AND** MUST NOT 混用兩個 space 的向量

---

### Requirement: kb_search 經完整 manifest 註冊並經統一 dispatch 執行

`kb_search` MUST 以完整 manifest 宣告：唯讀 side-effect class、明示 authorization action、in-process 執行 profile 與僅允許模型服務的 egress、唯讀冪等、無需審批、無補償及依語料的資料分級。`kb_search` MUST 只經統一 tool dispatch 執行；任何 graph 節點 MUST NOT 直接呼叫檢索邏輯。input MUST NOT 接受 tenant、principal 或審批欄位。

#### Scenario: 經 dispatch 執行

- **GIVEN** `kb_search` 已註冊
- **WHEN** agent 在對話中呼叫 `kb_search`
- **THEN** 呼叫 MUST 經過統一 dispatch、authorization 與 execution profile 判定
- **AND** 執行證據 MUST 記錄 tool 識別、版本與 correlation 識別

#### Scenario: input 夾帶身分欄位

- **GIVEN** 模型輸出的 `kb_search` 參數含 tenant 或 principal 欄位
- **WHEN** dispatch 驗證 input
- **THEN** MUST 以 schema error 拒絕
- **AND** MUST NOT 以該值改變檢索範圍

#### Scenario: authorization 拒絕

- **GIVEN** 目前 principal 沒有知識檢索的 authorization action
- **WHEN** 呼叫 `kb_search`
- **THEN** dispatch MUST 回傳 typed authorization denial
- **AND** MUST NOT 執行任何檢索或 embedding 呼叫

#### Scenario: manifest 缺欄位

- **GIVEN** `kb_search` manifest 缺少 execution profile 或 authorization action
- **WHEN** 註冊
- **THEN** 註冊 MUST fail-closed

---

### Requirement: 檢索階段、降級與檢索證據

`kb_search` MUST 依序執行 candidate recall、rerank、證據門檻與引用綁定。rerank 不可用時 MUST 降級為只用 recall，並在檢索證據中標記降級原因，MUST NOT 靜默降級。每次結果 MUST 附檢索證據：模式、embedding space、rerank 模型、門檻版本、設定版本、候選數與通過數。

#### Scenario: 正常檢索

- **GIVEN** 知識庫包含與問題相關的 chunk
- **WHEN** 呼叫 `kb_search`
- **THEN** 結果 MUST 為 evidence found，含 citations、chunks 與檢索證據
- **AND** 檢索證據的模式 MUST 為 vector 加 rerank

#### Scenario: rerank 不可用

- **GIVEN** rerank 供應商逾時或錯誤
- **WHEN** 呼叫 `kb_search`
- **THEN** 結果 MUST 以 recall-only 完成
- **AND** 檢索證據 MUST 標記降級模式與原因

#### Scenario: 查詢逾時或取消

- **GIVEN** `kb_search` 執行中
- **WHEN** 超過 tool timeout 或請求被取消
- **THEN** MUST 回傳 typed timeout 或取消結果
- **AND** MUST NOT 回傳部分結果作為成功

---

### Requirement: 證據門檻與拒答

證據門檻 MUST 為版本化設定，依檢索模式分別定義。沒有候選通過門檻時，`kb_search` MUST 回傳 no source found outcome。回答 MUST 明確聲明知識庫未涵蓋該問題，MUST NOT 以模型參數知識作答而不聲明來源缺失。

#### Scenario: 知識庫沒有答案

- **GIVEN** 問題不在知識庫涵蓋範圍內
- **WHEN** 呼叫 `kb_search`
- **THEN** 結果 MUST 為 no source found，並附檢索證據
- **AND** 最終回答 MUST 聲明知識庫未涵蓋，且不含任何 citation

#### Scenario: 門檻不得寫死

- **GIVEN** 門檻需要調整
- **WHEN** 更新門檻
- **THEN** MUST 以新的門檻版本設定生效
- **AND** 檢索證據 MUST 記錄使用的門檻版本

---

### Requirement: 引用可解析至已儲存 chunk

由知識庫衍生的回答 MUST 攜帶引用，每個引用 MUST 可解析至本輪 `kb_search` 回傳的已儲存 chunk 與其 provenance。無法解析的引用 MUST 被判定為失敗並發出可觀測事件。

#### Scenario: 引用可解析

- **GIVEN** `kb_search` 回傳 evidence found
- **WHEN** 回答引用其中的 citation
- **THEN** citation 驗證 MUST 通過
- **AND** 每個引用 MUST 對應來源識別、來源版本與位置

#### Scenario: 引用不可解析

- **GIVEN** 回答包含不在本輪 `kb_search` 結果中的引用
- **WHEN** 執行 citation 驗證
- **THEN** 驗證 MUST 失敗並發出驗證失敗事件
- **AND** 評測 MUST 將該案例計為引用錯誤

---

### Requirement: 檢索內容視為資料而非指令

chunk 內容 MUST 被視為不可信資料。chunk 中的指令性文字 MUST NOT 改變 agent 的 tool 選擇、身分、授權或回答策略。

#### Scenario: chunk 夾帶指令

- **GIVEN** 某 chunk 內容包含要求呼叫其他 tool 或忽略規則的文字
- **WHEN** 該 chunk 被 `kb_search` 召回
- **THEN** agent MUST NOT 因該文字呼叫其他 tool
- **AND** 回答 MUST NOT 遵循該指令

---

### Requirement: 檢索以 tenant 隔離

所有檢索 MUST 以 server 端 execution context 的 tenant 過濾。跨 tenant 召回 MUST 被拒絕並視為安全缺陷。

#### Scenario: 跨 tenant 召回被拒

- **GIVEN** tenant A 與 tenant B 各有語料
- **WHEN** tenant A 的對話呼叫 `kb_search`
- **THEN** 結果 MUST 只包含 tenant A 的 chunk
- **AND** 測試 MUST 證明 tenant B 的相同內容不會被召回

---

### Requirement: 衍生索引參與資料刪除

知識庫 MUST 登記為資料盤點中的非權威、可重建衍生資料。刪除或取代來源文件 MUST 同時刪除其所有 chunk 與索引項目。subject 刪除流程 MUST 列舉知識庫，並回報其不含該 subject 資料的結果。

#### Scenario: 來源刪除後零召回

- **GIVEN** 某來源文件已入庫且可被召回
- **WHEN** 刪除該來源
- **THEN** 其所有 chunk 與索引項目 MUST 被刪除
- **AND** 任何查詢 MUST NOT 再召回該來源

#### Scenario: 來源被新版本取代

- **GIVEN** 某來源的新版本完成入庫
- **WHEN** 查詢相關問題
- **THEN** MUST 只召回新版本的 chunk
- **AND** 舊版本 chunk MUST NOT 被回傳

#### Scenario: subject 刪除列舉知識庫

- **GIVEN** 一筆 subject 刪除請求
- **WHEN** deletion coordinator 執行
- **THEN** 知識庫 MUST 出現在列舉的 store 中
- **AND** MUST 回報不含該 subject 資料的 part result

---

### Requirement: 憑證不出現在任何可觀測面

embedding 與 rerank 的憑證 MUST NOT 出現在事件、checkpoint、log、trace、tool output 或模型 context 中。

#### Scenario: 洩漏掃描

- **GIVEN** 一次完整的入庫與一輪使用 `kb_search` 的對話
- **WHEN** 掃描該期間產生的事件、checkpoint、log 與模型 context
- **THEN** MUST NOT 出現已解析的憑證值

