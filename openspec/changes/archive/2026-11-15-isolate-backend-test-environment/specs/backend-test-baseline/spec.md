## ADDED Requirements

### Requirement: 預設測試程序 MUST NOT 載入開發者本機 runtime 設定檔

backend 預設測試程序 MUST NOT 讀取開發者本機為執行應用程式而建立的 runtime 設定檔。預設測試程序 MUST 改為載入一份納入版本控制、不含任何 Secret 的測試 fixture，且 MUST 能以自動化測試證明實際載入的來源是該 fixture。個別測試以測試框架明確設定的環境變數 MUST 仍然生效。

#### Scenario: runtime 設定檔存在時預設套件不讀取

GIVEN 開發者本機存在 runtime 設定檔，且其中設定了 proxy 與 Opik 啟用
AND 所有外部環境測試的 opt-in 皆未啟用
WHEN 執行 backend 預設測試
THEN 測試程序中 MUST NOT 出現該設定檔提供的任何變數
AND 結果 MUST 與 runtime 設定檔不存在時相同（相同 passed／failed／skipped 數）

#### Scenario: 載入來源可被自動化證明

GIVEN 預設測試程序已啟動
WHEN hermetic 守門測試檢查環境來源標記
THEN 來源標記 MUST 等於測試 fixture 的值
AND 守門測試 MUST NOT 讀取或比較 runtime 設定檔的內容

#### Scenario: 守門設定被移除時 Gate 失敗

GIVEN 有人移除了預設測試程序的環境隔離設定
WHEN 執行 backend 預設測試
THEN hermetic 守門測試 MUST 失敗
AND MUST NOT 被 skip

#### Scenario: 個別測試的明確設定仍生效

GIVEN 一個測試以測試框架明確設定某環境變數
WHEN 該測試執行
THEN 該測試讀到的值 MUST 為其明確設定的值
AND 測試結束後 MUST 回到預設測試程序的隔離值

### Requirement: 預設測試程序 MUST 停用 proxy 與 Opik 匯出

backend 預設測試程序 MUST 在程序層級停用 proxy 設定與 Opik 匯出，且 MUST 覆蓋開發者 shell 中既有的同名設定。預設測試程序中 MUST NOT 發生全域 proxy dispatcher 設定，MUST NOT 對 hosted Opik 建立連線。需要驗證 proxy 或 Opik 啟用語意的單元測試 MUST 以明確設定與假 client 進行，不得連線真實外部服務。

#### Scenario: shell 中 proxy 指向不可達位址時預設套件不受影響

GIVEN 開發者 shell 中 proxy 相關環境變數指向一個不可達的位址
AND 所有外部環境測試的 opt-in 皆未啟用
WHEN 執行 backend 預設測試
THEN 測試程序 MUST NOT 設定全域 proxy dispatcher
AND MUST NOT 輸出 proxy 已設定的事件
AND 結果 MUST 與 shell 未設定 proxy 時相同

#### Scenario: shell 中 Opik 啟用時預設套件不匯出

GIVEN 開發者 shell 中 Opik 啟用且設定了認證變數名稱
AND 所有外部環境測試的 opt-in 皆未啟用
WHEN 執行 backend 預設測試
THEN 預設 Opik tracer MUST 為 Noop
AND MUST NOT 對 hosted Opik 建立任何連線

#### Scenario: 外部服務緩慢時不產生逾時連鎖

GIVEN 開發者環境的 proxy 或 Opik 服務緩慢或無回應
WHEN 對同一組 LLM Gateway 相關測試檔連續執行兩次預設測試
THEN 兩次 MUST 全數通過
AND 兩次的案例數與 passed 數 MUST 相同
AND 任一案例 MUST NOT 因等待外部服務而逾時

#### Scenario: 單元測試明確開啟 Opik 語意

GIVEN 一個單元測試需要驗證 Opik 啟用時的行為
WHEN 該測試明確設定 Opik 啟用並注入假 client
THEN 測試 MUST 觀察到啟用語意
AND MUST NOT 連線真實 hosted Opik

#### Scenario: 預設測試被中斷

GIVEN 一次預設測試在完成前被取消或中斷
WHEN 彙整 hermetic 驗證結果
THEN 該次執行 MUST 記為未完成
AND MUST NOT 作為環境矩陣通過的證據

### Requirement: live 測試 MUST 使用專用 live 測試設定執行

需要真實 runtime 設定、proxy 或 hosted 服務的 live 測試（包括 Opik live smoke）MUST 由專用的 live 測試設定執行；該設定 MUST 保留 runtime 設定檔與 proxy 的既有行為，且只收集 live 測試。live 測試的啟用條件 MUST 仍為既有的專用 opt-in 旗標。預設測試程序 MUST NOT 為了讓 live 測試可跑而恢復載入 runtime 設定檔。

#### Scenario: 以 live 設定執行 Opik live smoke 且環境可用

GIVEN Opik live smoke 的 opt-in 旗標已啟用
AND runtime 設定與 hosted Opik 可用
WHEN 以專用 live 設定執行 Opik live smoke
THEN 測試 MUST 實際執行其斷言
AND 結果 MUST 為通過

#### Scenario: 以 live 設定執行但未啟用 opt-in

GIVEN Opik live smoke 的 opt-in 旗標未啟用
WHEN 以專用 live 設定執行 Opik live smoke
THEN 該測試 MUST 被 skip
AND 驗證報告 MUST 列出被 skip 的 suite 名稱與原因

#### Scenario: 以預設設定啟用 live opt-in

GIVEN 開發者在 shell 啟用了 Opik live smoke 的 opt-in 旗標
WHEN 以預設測試程序執行該 live smoke
THEN 該測試 MUST 失敗並指出缺少的設定名稱
AND MUST NOT 改讀 runtime 設定檔來讓測試通過

#### Scenario: live 執行逾時

GIVEN Opik live smoke 以 live 設定執行且 opt-in 已啟用
AND hosted 呼叫超過該測試宣告的逾時
WHEN 執行該測試
THEN 測試 MUST 以逾時失敗
AND MUST NOT 以重試或延長固定延遲掩蓋

#### Scenario: live 設定不影響預設 Gate

GIVEN 專用 live 設定存在
WHEN 執行 backend 預設測試
THEN 預設測試程序 MUST NOT 套用 live 設定的環境行為
AND 預設 Gate 的結果 MUST NOT 依賴 live 測試是否可執行
