## ADDED Requirements

### Requirement: backend 預設測試套件 MUST hermetic

backend 預設測試套件的結果 MUST NOT 依賴開發者本機為執行應用程式而設定的 runtime 外部服務設定（例如資料庫連線字串）。任何以「某 dependency 未提供」為前提的測試 MUST 明確隔離該 dependency 的 production default，不得因環境中存在對應設定而改走其他路徑。

#### Scenario: runtime 資料庫設定指向不可達位址時預設套件仍通過

GIVEN 環境中 runtime 資料庫連線設定指向一個不可達的位址
AND 所有外部環境測試的 opt-in 皆未啟用
WHEN 執行 backend 預設 lint、test 與 build
THEN 全部 MUST 通過
AND 任何非 opt-in 測試 MUST NOT 嘗試連線該位址

#### Scenario: 未設定 runtime 資料庫時結果相同

GIVEN 環境中未設定 runtime 資料庫連線
AND 所有外部環境測試的 opt-in 皆未啟用
WHEN 執行 backend 預設 lint、test 與 build
THEN 結果 MUST 與 runtime 資料庫設定指向不可達位址時相同（相同 passed／failed／skipped 數）

#### Scenario: 修正不得放寬斷言

GIVEN 一個測試因環境洩漏而得到非預期結果
WHEN 修正該測試
THEN MUST 以隔離前提修正
AND MUST NOT 放寬、刪除或改寫原有斷言的預期值

### Requirement: 需要外部環境的測試 MUST 以專用 opt-in gating

需要真實外部服務（資料庫、hosted 評估平台、live 模型）的測試 MUST 由專用的 opt-in 旗標啟用，不得以 runtime 設定是否存在作為啟用條件。未啟用時 MUST skip，並在驗證報告中列出；啟用後外部環境不可用、設定缺失或逾時 MUST 判定為失敗，不得 skip。

#### Scenario: 未啟用 opt-in 時 skip 並列入報告

GIVEN 某外部環境測試的 opt-in 旗標未啟用
WHEN 執行 backend 預設測試
THEN 該測試 MUST 被 skip
AND 驗證報告 MUST 列出被 skip 的 suite 名稱與原因

#### Scenario: 啟用 opt-in 且環境可用時執行並通過

GIVEN 某外部環境測試的 opt-in 旗標已啟用
AND 對應外部環境可用且設定完整
WHEN 執行該測試
THEN 測試 MUST 實際執行其斷言
AND 結果 MUST 為通過

#### Scenario: 啟用 opt-in 但環境不可用時失敗

GIVEN 某外部環境測試的 opt-in 旗標已啟用
AND 對應外部環境無法連線或必要設定缺失
WHEN 執行該測試
THEN 測試 MUST 失敗並指出缺少的設定名稱或連線失敗類別
AND MUST NOT 被 skip 或視為通過

#### Scenario: 啟用 opt-in 但逾時時失敗

GIVEN 某外部環境測試的 opt-in 旗標已啟用
AND 外部呼叫超過該測試宣告的逾時
WHEN 執行該測試
THEN 測試 MUST 以逾時失敗
AND MUST NOT 以重試或延長固定延遲掩蓋

#### Scenario: 被中斷的執行不計為通過

GIVEN 一次測試執行在完成前被取消或中斷
WHEN 彙整驗證結果
THEN 該次執行 MUST 記為未完成
AND MUST NOT 作為基準通過的證據

### Requirement: Evaluation harness 呼叫 graph 時 MUST 經由 trusted identity 管道提供身分

Evaluation harness（例如 hosted Opik experiment）以 graph 執行 evaluation item 時，MUST 經由 graph 入口在 production 模式本來就接受的 trusted identity 欄位與 correlation 欄位提供身分，使入口以既有規則重建的 execution context 通過 canonical 驗證。Evaluation MUST NOT 依賴呼叫端自帶的 execution context、放寬 graph 入口或 Runtime Validation、使用依執行環境切換的開發預設、繞過入口直接呼叫內部 graph，或在 graph 中為 evaluation 新增特殊分支。trusted identity 欄位名稱 MUST 取自 runtime 既有的單一來源。

#### Scenario: 每個 item 經入口重建出完整 execution context

GIVEN 一次 evaluation experiment 包含多個將被執行的 item
WHEN harness 以 graph 執行每個 item
THEN 入口重建的 execution context MUST 通過 canonical 驗證
AND 其 principal 與 scope MUST 等於 harness 提供的 evaluation 身分
AND 每個 item 的 requestId 與 runId MUST 彼此不同
AND item MUST NOT 因缺少 execution context 欄位而失敗

#### Scenario: 不同 experiment 的 evaluation 身分彼此隔離

GIVEN 兩次 evaluation experiment 使用不同的 experiment 識別
WHEN harness 建立它們的 trusted identity
THEN 兩者的 principal 與 tenant scope MUST 不同
AND MUST NOT 共用固定的 principal 或 tenant

#### Scenario: graph 入口的驗證規則不因 evaluation 改變

GIVEN 一個沒有 trusted identity 欄位的 graph 呼叫
WHEN 該呼叫經過 graph 入口
THEN 入口 MUST 依既有規則拒絕
AND 呼叫端自帶的 execution context MUST 仍被入口忽略
AND 本修正 MUST NOT 放寬上述行為

#### Scenario: identity status 檢查開啟時不得偽造帳號

GIVEN 環境開啟 runtime identity status 檢查
AND evaluation 身分沒有 account 與 session
WHEN harness 以 graph 執行 item
THEN 入口 MUST 依既有規則拒絕
AND harness MUST NOT 偽造 account 或 session 來通過檢查
AND 該次 live 結果 MUST 記為失敗

#### Scenario: 入口契約的驗證必須經過真實入口

GIVEN 一個驗證 evaluation 進入 graph 方式的自動化測試
WHEN 該測試斷言身分與 correlation 被 graph 接受
THEN 測試 MUST 經過真實的 graph 入口 resolver
AND MUST NOT 以替換整個 graph 模組的方式略過入口

#### Scenario: 修正後 live 重跑出現其他失敗層級

GIVEN execution context 已補齊
AND live 重跑仍有 item 未完成
WHEN 彙整 live 證據
THEN 證據 MUST 記錄每個 item 的 status 與錯誤類別
AND 該結果 MUST NOT 被記為通過

### Requirement: 基準驗證證據 MUST 可追溯

宣告 backend 測試基準通過時，證據 MUST 記錄每次執行的命令、相關環境變數名稱與其「已設定／未設定／空字串」狀態、exit code、passed／failed／skipped 數與 skip 的 suite 名稱，且 MUST NOT 記錄任何環境變數的值。

#### Scenario: 證據不含 Secret

GIVEN 一份基準驗證證據
WHEN 檢查其內容
THEN MUST 只包含環境變數名稱與狀態
AND MUST NOT 包含連線字串、API Key、Token 或密碼
