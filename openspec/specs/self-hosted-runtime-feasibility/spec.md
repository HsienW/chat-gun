# self-hosted-runtime-feasibility Specification

## Purpose
定義以未修補的開源 LangGraph server 自建映像進行單一實例 demo 可行性驗證的範圍、證據、故障不變量與結論要求，涵蓋重啟持久化、串流取消、BFF／前端相容性及資源量測。
## Requirements
### Requirement: 自建開源 server 映像不依賴專有元件且不修改產品程式

可行性驗證所用的 backend server 映像 MUST 只以開源授權的套件建置，MUST NOT 修補或 fork 該套件，MUST NOT 修改 frontend、bff、backend 的產品程式。映像 MUST NOT 包含 secret。驗證報告 MUST 記錄套件版本與啟動命令。

#### Scenario: 映像啟動並 ready

- **GIVEN** 以自建映像啟動 server，並注入 demo 所需環境變數
- **WHEN** BFF 以 demo 模式連線並執行 ready 檢查
- **THEN** ready 回報成功，已註冊 graph 可建立 run

#### Scenario: 映像不含 secret

- **GIVEN** 自建映像建置完成
- **WHEN** 掃描映像各層與設定檔
- **THEN** 不含任何 API Key、密碼或憑證
- **AND** 每筆疑似命中 MUST 以可重現方式逐筆判讀，記錄掃描規則、映像層、檔案路徑、判讀結論與理由
- **AND** 判讀為 secret 的命中使該驗證項目不通過，MUST 移除後重新建置與掃描
- **AND** 判讀為誤判且理由已記錄的命中不阻擋通過
- **AND** MUST NOT 以路徑或檔案白名單略過判讀

#### Scenario: 缺少必要設定時行為與既有 runtime 一致

- **GIVEN** 自建映像與既有 `langgraphjs dev` runtime 在相同環境變數下啟動，且兩者都缺少模型 API Key
- **WHEN** 兩者分別啟動，並由 BFF 以 demo 模式執行 ready 檢查
- **THEN** 自建映像的啟動結果與 ready 結果 MUST 與既有 runtime 一致，並記錄兩者的實際輸出
- **AND** 不得以預設值或假模型代替缺少的金鑰
- **AND** 若兩者都回報 ready，記錄為既有產品的設定檢查缺口，不判定為自建 server 不可行

### Requirement: 重啟與異常終止的行為以實測證據判定

驗證 MUST 先確認 server 對「使用 server 提供 checkpointer 的 graph」與「自帶 checkpointer 的 graph」各自實際生效的 checkpointer，並據此訂定各 graph 的預期。驗證 MUST 以真實 graph 與實際 checkpoint 執行正常重啟（SIGTERM）與異常終止（SIGKILL）測試，MUST NOT 只以 mock state 推論。每個測試 MUST 記錄終止時點、遺失的資料範圍，以及重啟後 thread、interrupt、run 與 side-effect 的狀態。

#### Scenario: 自帶 checkpointer 的 graph

- **GIVEN** `deep_researcher` 自帶 checkpointer，`shopping_assistant` 使用 server 提供的 checkpointer
- **WHEN** 在自建 server 上各建立一個 run 並重啟
- **THEN** 報告記錄兩者實際生效的 checkpointer 與重啟後狀態
- **AND** 後續驗證對兩個 graph 的預期依此結果訂定，不混為同一預期

#### Scenario: 正常重啟後等待中的審批可恢復

- **GIVEN** 一個 Gun Shop 訂單 run 停在審批 interrupt，且已閒置超過寫檔延遲
- **WHEN** server 以 SIGTERM 重啟
- **THEN** 該 thread 歷史完整，interrupt 可被 resume 一次並成功
- **AND** side-effect MUST 只執行一次，此條件不得放寬
- **AND** 對同一 interrupt 送出相同的第二次 resume 時，自建映像與既有 `langgraphjs dev` 在相同環境下的 HTTP 回應、run 狀態與是否產生 rejected audit MUST 一致，並記錄兩者的實際輸出
- **AND** 若兩者都未明確拒絕第二次 resume，記錄為既有產品的規格缺口，不判定為自建 server 不可行

#### Scenario: interrupt 建立後立即異常終止

- **GIVEN** 一個審批 interrupt 剛建立，尚未超過寫檔延遲
- **WHEN** server 被 SIGKILL 終止並重啟
- **THEN** 報告記錄該 interrupt 是否保留，以及遺失資料的範圍與最早遺失資料的年齡
- **AND** 遺失範圍 MUST NOT 超過「最近一次連續至少一個寫檔延遲期間沒有存取之後的全部活動」；超出此範圍即不通過
- **AND** 若未保留，重啟後的狀態 MUST 可被讀取且不處於無法 deserialize 或 terminal 回到 running 的狀態

#### Scenario: resume 期間異常終止

- **GIVEN** 審批 resume 已送出，side-effect 執行前後各一個時點
- **WHEN** server 被 SIGKILL 終止並重啟
- **THEN** side-effect 沒有重複執行
- **AND** 若 side-effect 已執行但對應 checkpoint 遺失，使重啟後審批重新回到等待中，再次核准 MUST NOT 產生第二次 side-effect，並記錄由哪一個既有機制擋下
- **AND** 報告記錄最終的 run 與訂單狀態

#### Scenario: 串流進行中異常終止

- **GIVEN** 一個串流 run 進行中
- **WHEN** server 被 SIGKILL 終止
- **THEN** BFF 回報可辨識的上游錯誤，lease 依既有規則在 TTL 內回收
- **AND** 報告記錄重啟後該 run 的狀態

### Requirement: 串流、取消與 BFF 相容性維持既有語意

經 BFF demo 模式使用自建 server 時，串流事件 MUST 逐段送達；用戶端斷線後 run MUST 進入 terminal，lease MUST 在 terminal 確認後釋放且只釋放一次；BFF 與 frontend MUST 不修改程式即可完成 Gun Chat、深度研究與 Gun Shop 審批流程，錯誤碼與降級行為 MUST 與既有規格一致。

#### Scenario: 串流逐段送達

- **GIVEN** 經 BFF 建立一個 Gun Chat 串流 run
- **WHEN** run 進行中
- **THEN** 用戶端在 run 完成前收到多個事件段

#### Scenario: 用戶端斷線

- **GIVEN** 一個持有 lease 的深度研究串流 run
- **WHEN** 用戶端中途斷線
- **THEN** run 進入 terminal，lease 在確認後釋放一次

#### Scenario: 前端完成審批流程

- **GIVEN** 瀏覽器經 BFF 使用 Gun Shop
- **WHEN** 訪客提出退款並在 UI 核准
- **THEN** 流程完成，狀態卡片顯示結果，與既有行為一致

### Requirement: 資源用量在門檻內

模擬 Master 指定的一週 demo 流量後，server 程序記憶體與持久化目錄大小 MUST 落在 Master 指定的門檻內；報告 MUST 記錄量測方法、數值與重啟載入時間。量測可使用本機假模型端點，但 MUST NOT 以此判斷模型語意。

#### Scenario: 一週流量模擬

- **GIVEN** 依指定訪客數、輪數與天數產生的流量
- **WHEN** 模擬完成並重啟 server
- **THEN** 記憶體與目錄大小在門檻內，報告記錄載入時間
- **AND** 報告記錄模擬期間最長的未寫檔間隔，作為異常終止時最壞遺失範圍的參考

#### Scenario: 超出門檻

- **GIVEN** 模擬後記憶體或目錄大小超出門檻
- **WHEN** 整理報告
- **THEN** 該項標示不通過，並記錄成長趨勢與可能的清理方式

### Requirement: 可行性結論包含規格偏離分析且不含私有決策

結論報告 MUST 逐項列出各驗證項目的結果與證據引用，MUST 逐條比對 `durable-hitl-conversation-recovery`、`multi-instance-operation` 與相關 runtime 規格並標示符合、demo 下偏離或不適用，MUST 給出採用、有條件採用或不採用的建議與條件。報告 MUST NOT 包含帳戶方案、授權結論或其他私有部署決策。未執行的項目 MUST 標示未驗證，MUST NOT 推定通過。

#### Scenario: 部分項目未執行

- **GIVEN** V5 因環境限制未執行
- **WHEN** 撰寫結論
- **THEN** V5 標示未驗證，整體建議最高只能是有條件採用

#### Scenario: 多實例規格偏離

- **GIVEN** 自建 server 只支援單一實例
- **WHEN** 比對 `multi-instance-operation`
- **THEN** 報告標示 demo 下偏離，並說明部署規格需要如何聲明

### Requirement: 公開保存的 runtime 產出只含可對外內容

版本控制中保存的自建 runtime 產出 MUST 只包含下游部署會使用的映像建置設定、啟動入口與對外說明文件。對外說明文件與保留的檔案 MUST NOT 包含內部 agent 工作流程細節（交接編號、共享狀態、角色或 owner、仲裁輪次）、本機 Runtime Artifact 路徑、evidence 識別碼，或 Git 忽略的私有設定檔名稱與內容描述。一次性驗證工具 MUST NOT 保留在目前 tree；其歷史版本 MUST 可由明確的 commit 引用追溯。保留的建置與啟動行為 MUST 與移除前一致。

#### Scenario: 保留內容滿足下游部署

- **GIVEN** 公開產出已依內容邊界整理
- **WHEN** 以保留的建置設定建置 runtime 與 BFF 映像
- **THEN** 兩個映像建置成功
- **AND** 映像的啟動命令與移除前相同
- **AND** 下游部署 Change 引用的建置與啟動檔案都存在

#### Scenario: 公開內容不含內部工作流程細節

- **GIVEN** 公開產出已依內容邊界整理
- **WHEN** 搜尋保留檔案中的內部工作流程字樣、本機 Runtime Artifact 路徑與私有設定檔名稱
- **THEN** 沒有任何命中
- **AND** 任一命中使該驗收項目不通過，MUST 修正後重新搜尋，MUST NOT 以路徑白名單略過

#### Scenario: 一次性驗證工具仍可追溯

- **GIVEN** 一次性驗證工具已從目前 tree 移除
- **WHEN** 讀者依可行性結論中的重現說明查找工具
- **THEN** 說明 MUST 指向保存工具的 commit
- **AND** 該 commit 中的工具內容與移除前一致

#### Scenario: 下游仍依賴已移除的檔案

- **GIVEN** 下游部署 Change 的規格、設計或任務引用了將被移除的檔案
- **WHEN** 進行驗收前的依賴搜尋
- **THEN** 該驗收項目不通過
- **AND** MUST 回報 Coordinator 決定保留該檔案或先調整下游 Change，MUST NOT 直接修改下游 Change

