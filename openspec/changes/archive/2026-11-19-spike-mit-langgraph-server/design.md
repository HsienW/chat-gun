## Context

- backend 的已註冊 graph（`shopping_assistant`、`mcp_agent` 等）使用 server 提供的 checkpointer（`checkpointer: "langgraph_managed"`）；`deep_researcher` 使用自己的 `MemorySaver`。長期記憶使用 `PostgresStore`（`@langchain/langgraph-checkpoint-postgres/store`），與 run／checkpoint 儲存無關。
- 本機開發以 `langgraphjs dev`（`@langchain/langgraph-cli` 1.4.5，內含 `@langchain/langgraph-api`）執行。
- `@langchain/langgraph-api` 的儲存層（`src/storage/`）：`InMemorySaver` 加 `FileSystemPersistence`，寫入 `.langgraph_api/`，變更後約 3 秒 debounce 寫檔，沒有結束時的強制寫檔。
- `demo-cost-and-access-guard` 的 6.1 曾以真實 BFF、LangGraph server、Redis 與 PostgreSQL 驗證 demo 流程，可作為 V3 的程序參考。

## Goals / Non-Goals

見 proposal。

## 各套件變更

- **frontend／bff／backend**：無程式變更。BFF 以既有 demo 模式設定連到自建 server。
- **新增**：自建 server 映像設定、只用於本機驗證的 compose 設定、驗證腳本、結論報告。

## Decisions

### D-1：自建 server 映像

- 以 Node LTS 官方映像為基底，安裝 backend 相依（含 `@langchain/langgraph-cli` 或 `@langchain/langgraph-api`），以官方 CLI 或套件提供的啟動方式執行 backend 的 `langgraph.json`；監聽位址與埠由環境變數設定。
- 啟動方式以套件官方文件或原始碼為依據，在報告記錄所用版本與命令；不得修補或 fork 套件。
- `.langgraph_api/` 掛載具名 volume。
- 映像不得包含 secret；模型 API Key 由執行時環境變數注入。

### D-2：驗證拓撲

本機 compose：自建 server、BFF（demo 模式，`DEMO_ENABLED=true`）、Redis（帳本與准入）、knowledge PostgreSQL（pgvector）。frontend 由 BFF 提供。帳本使用獨立鍵前綴。V1 至 V4 使用真實模型，以最少次數執行；V5 依 OD-2 可改用本機假模型端點，只量測資源，不據以判斷模型語意。

### D-3：驗證項目

| ID | 項目 | 方法 | 通過標準 |
| --- | --- | --- | --- |
| V1 | 正常重啟 | 建立 Gun Chat 對話與一個等待審批的 Gun Shop 訂單 interrupt，閒置超過寫檔延遲後以 SIGTERM 重啟 server | thread 歷史完整；等待中 interrupt 可 resume 一次且成功；side-effect 只執行一次（不得放寬）；第二次相同 resume 的 HTTP 回應、run 狀態與 rejected audit 與既有 `langgraphjs dev` 對照一致 |
| V2 | 異常終止 | 在三個時點以 SIGKILL 終止：(a) interrupt 建立後立即、(b) 串流進行中、(c) resume 送出後 side-effect 完成前後 | 記錄每個時點遺失的資料範圍與最早遺失資料的年齡；可接受遺失範圍為「最近一次連續至少一個寫檔延遲期間沒有存取之後的全部活動」（寫檔延遲為存取後重新計時，不是資料年齡上限），超出即不通過；不得出現 side-effect 重複執行、terminal 回到 running，或無法 deserialize 的狀態；(c) 若 side-effect 已執行而 checkpoint 遺失、審批回到等待中，再次核准不得產生第二次 side-effect |
| V3 | 串流與取消 | 經 BFF demo 模式建立串流 run；中途斷線 | 事件逐段送達；斷線後 run 進入 terminal；lease 在 terminal 確認後釋放且只釋放一次 |
| V4 | BFF 與前端相容 | 以瀏覽器經 BFF 操作 Gun Chat、深度研究開關與 Gun Shop 審批流程 | 不修改 BFF 與 frontend 程式即可完成；錯誤碼與降級畫面與既有行為一致 |
| V5 | 資源 | 模擬一週 demo 流量（OD-3 的訪客數與輪數） | server 記憶體與 `.langgraph_api/` 大小落在 OD-3 門檻內；記錄重啟載入時間 |

| V0 | checkpointer 優先順序 | 在自建 server 上分別對使用 server 提供 checkpointer 的 graph（`shopping_assistant`）與自帶 `MemorySaver` 的 graph（`deep_researcher`）建立 run，檢查實際生效的 checkpointer（以 server 的持久化檔案是否寫入該 thread、重啟後 thread 是否可讀判定） | 兩類 graph 的實際行為都有證據；V1 至V4 對各 graph 的預期依此結果訂定並寫入報告 |

V0 先於 V1 執行。若 `deep_researcher` 的自帶 checkpointer 生效，該 graph 的狀態在重啟後遺失屬於既有設計（與本機 `langgraphjs dev` 相同），報告記錄為已知行為，不視為自建 server 的缺陷；若 server 覆蓋，報告記錄語意差異。

每項保存命令、輸出、時間點與環境（OS、Docker 版本、套件版本）。

### D-4：規格偏離分析

報告必須以 Requirement 為單位逐條比對下列規格，每條標示「符合／demo 下偏離／不適用／未驗證」，附證據或不適用理由。判定依據是該 Requirement 所依賴的 checkpoint 與持久化前提在自建 server 上是否成立；backend 自己實作的機制（manifest、sanitizer、classifier 等）不因換 server 而改程式，但其持久化前提必須重新確認。

`durable-hitl-conversation-recovery`（7 條）：

| Requirement | 本 spike 要確認的前提 |
| --- | --- |
| 統一 DurableInterruptManifest 持久化 | manifest 與 checkpoint 在重啟、異常終止後是否都保留且一致（V1、V2） |
| resume 只回到預期 waiting Task 且最多消費一次 | 重啟後 resume 一次成功、重放被拒（V1、V2c） |
| RecoverySanitizer 於 resume 前驗證 protocol-validity | 重啟後讀回的 checkpoint 能被 sanitizer 正常驗證；異常終止產生的不完整狀態被拒而非放行（V2） |
| LastExecutionPointClassifier 分類最後持久化進度 | 異常終止後 classifier 的輸入（checkpoint、ledger、manifest）可讀，分類結果記錄於報告（V2） |
| cancellation reason 與 transport disconnect 分離 | 斷線取消後 run 的終止原因與既有語意一致（V3） |
| CrashTerminalPolicy 明確定義 | 異常終止後是否觸發 crash terminal 判定，結果記錄（V2） |
| recovery integration 使用實際 checkpoint | 所有 V1、V2 測試都使用實際 checkpoint（本 spike 的證據要求） |

`langgraph-runtime-boundary`（7 條）：

| Requirement | 本 spike 要確認的事 |
| --- | --- |
| 現況盤點（Graph 編譯與 Checkpointer 使用） | 自建 server 上各已註冊 graph 的編譯與 checkpointer 來源（V0） |
| langgraph dev 生命週期實證 | 自建 server 的啟動、ready、重啟與結束行為與既有實證比較（V0、V1） |
| Checkpointer 與持久化邊界驗證 | server 與 graph 自帶 checkpointer 的邊界、持久化寫入時機（V0 至 V2） |
| 原生訊號到 Chat-Gun 概念的映射 | interrupt、取消、錯誤等原生訊號經 BFF 後的映射不變（V3、V4） |
| 權威來源定義 | run 與 checkpoint 的權威來源在自建 server 上為持久化檔案，與既有定義的差異 |
| Failure Drills | V2 的三個終止時點作為 drill 證據；未涵蓋的 drill 標示未驗證 |
| Decision Record 產出 | 本 spike 的 `findings.md` 即為 decision record |

`multi-instance-operation`（7 條）：

| Requirement | 預期判定與要確認的事 |
| --- | --- |
| 多 instance 對 shared durable state 安全並行 | demo 下偏離：自建 server 只支援單一實例 |
| run/job ownership 以 fencing token 安全 takeover | demo 下偏離：無第二實例可接手 |
| 事件 sequence 跨 instance resume 不重算 | demo 下偏離；另確認單一實例重啟後 sequence 不重算、不倒退（V1、V2） |
| projection 由 authoritative facts 重建 | 確認單一實例重啟後 projection 是否由 checkpoint 等權威資料重建（V1） |
| multi-instance 模式禁止 NoopStepLock | 不適用：demo 不啟用 multi-instance 模式；報告確認 demo 設定未啟用 |
| session revocation 與 approval resumption 讀取 durable store | 確認重啟後 approval resumption 讀到的是持久化資料而非程序記憶體殘留（V1、V2c） |
| controlled leader election 僅限 singleton work | 不適用或偏離：單一實例無 leader election；報告記錄 singleton work（例如 cron，demo 已停用）的狀態 |

報告說明偏離的影響與部署規格需要如何聲明（例如 demo profile 限定單一實例、不啟用 multi-instance 模式）。

`demo-deployment-profile`：與 server 啟動、ready、run 生命週期與 lease 有關的 Requirement 逐條標示（V3、V4）。

### D-5：結論報告

- 位置：`openspec/changes/spike-mit-langgraph-server/findings.md`。內容只含技術事實與量測，不含帳戶、授權結論或其他私有部署決策。
- 格式：每項 V1 至 V5 的結果與證據引用、D-4 偏離表、整體建議（採用／有條件採用／不採用）與條件清單。
- 原始 evidence 存放於 `.agent-runtime/spike-mit-langgraph-server/artifacts/`。

## 替代方案

- **自訂 Postgres checkpointer 注入開源 server**：需要修改或延伸套件，超出 spike 範圍；若 V2 結果不可接受，可作為後續 Change。
- **託管部署**：不在本 Change 評估。

## Risks / Trade-offs

- **[V2 造成資料遺失]** → 正是要量測的項目；結果決定是否需要額外的寫檔保護或改採其他方案。
- **[真實模型費用]** → V1 至 V4 以最少次數執行；V5 可用假模型端點（OD-2）。
- **[開源套件版本更新改變行為]** → 報告記錄確切版本；部署時鎖定相同版本。

## Master 決策（OD）

Master 已於 2026-11-17 採納下列建議，全部定案。

| ID | 問題 | 定案 | 理由 |
| --- | --- | --- | --- |
| OD-1 | 映像設定與驗證檔案位置 | `deploy/self-hosted-runtime/` | 之後部署 Change 可直接沿用 |
| OD-2 | V5 是否允許使用本機假模型端點 | 允許，只量測資源，不據以判斷模型語意；報告須註明 | 避免模擬一週流量的模型費用 |
| OD-3 | V5 的流量、模擬方式與資源門檻 | 共 280 輪（4 位訪客 × 10 輪 × 7 天），以加速方式依序執行（不壓縮成高併發；最多 3 個並行，等於 demo 並行上限），每天之間重啟一次 server；server 記憶體上限 1 GiB、`.langgraph_api/` 上限 500 MiB；報告記錄模擬方式與其與真實時間分布的差異 | 與 demo 存取上限一致，且可在本機完成 |

## review-plan 仲裁紀錄

`review-result-review-plan-001` 由 adapter 保存，effective verdict INCOMPLETE：evidence gate 因原始輸出含疑似 secret 而不通過（`durable-hitl-conversation-recovery/spec.md` 第 54 行描述一次性憑證用途的英文片語被偵測規則誤判為 token，經 CCR 確認檔案不含任何憑證），且 reviewer 因無法自行確認模型 ID 而自評 INCOMPLETE（adapter 已驗證 provider 與模型）。審查內容 2 Major、2 Minor，CCR 判斷全部成立並於 attempt 2 採納：

| 來源 | 內容 | 採納位置 |
| --- | --- | --- |
| Major 1 | D-4 改為 Requirement 層級逐條比對，涵蓋 manifest、resume 一次性、sanitizer、classifier、取消原因、crash terminal | D-4 |
| Major 2 | 新增 V0 確認 server checkpointer 與 graph 自帶 checkpointer 的優先順序，並據以訂定各 graph 的預期 | D-3、spec、tasks 2.0 |
| Minor 1 | V5 模擬方式 | OD-3 |
| Minor 2 | 映像不含 secret 的 Scenario | spec |

attempt 2：`review-result-review-plan-002` verdict APPROVE（0 Blocker／0 Major／1 Minor），但 evidence gate 再次因同一偵測規則不通過，觸發來源是本 design 仲裁紀錄中引用的同一英文片語，已於 attempt 3 改寫。Minor（`multi-instance-operation` 只列 3 條、實有 7 條）採納，D-4 改為 7 條逐條列出。

attempt 3：`review-result-review-plan-003` 由 adapter 保存，evidence gate 通過，verdict COMMENT_ONLY（0 Blocker／0 Major／2 Minor）。CCR 仲裁兩個 Minor 全部採納：`langgraph-runtime-boundary` 7 條改為表格逐條列出（D-4）；V2 通過標準明訂寫檔延遲窗口內的遺失為可接受結果但須記錄（D-3）。兩項皆為表述明確化，不改變 Requirement 語意，不需重新審查。

apply-change 001 仲裁（attempt 4）：Codex 的 `implementation-result-apply-001` 為 partial，task 1.1 兩項不符，依 onFailure 交回 CCR。CCR 仲裁如下：

| Finding | 判定 | 處理 |
| --- | --- | --- |
| F001 缺少模型金鑰仍回 ready | 規格前提錯誤，不屬自建 server 缺陷。`demo-deployment-profile` 已核准的 backend 必要設定不含模型金鑰，backend 於呼叫模型時才讀取金鑰，原 Scenario 所稱「既有啟動檢查」不存在 | spec Scenario 改為與既有 `langgraphjs dev` 在相同環境下對照，行為一致即通過；產品設定缺口列為下游部署 Change 的待辦，不在本 Change 修改 |
| F002 映像掃描疑似命中未判讀 | 原 Scenario 要求所有疑似命中都移除，命中位於系統二進位與套件來源時無法達成，造成永久不通過 | spec Scenario 改為逐筆可重現判讀：確認為 secret 時不通過並移除重建；誤判且理由已記錄時不阻擋；禁止路徑白名單略過 |

兩項修改改變 Scenario 語意，送 Qwen 重新 review-plan（004）。Codex 已產出的 `deploy/self-hosted-runtime/` 與 evidence 保留，續作時沿用。

apply-change 002 仲裁（attempt 5）：`implementation-result-apply-002` 為 partial，task 1.1 與 V0 通過，V1 出現 F003（第二次相同 resume 回 HTTP 200 success，未明確拒絕；side-effect 只有一次）。CCR 仲裁如下：

| Finding | 判定 | 處理 |
| --- | --- | --- |
| F003 重放 resume 未明確拒絕 | Scenario 前提錯誤，不屬自建 server 缺陷。自建映像與 `langgraphjs dev` 使用同一個開源 server 套件；thread 已無等待中 interrupt 時，server 層把 resume 視為 no-op 並回傳目前狀態。產品的重放拒絕與 audit 位於 graph 的確認節點內，只在節點重新執行時觸發，不提供 HTTP 層拒絕。最重要的安全性質（side-effect 只執行一次）已實測成立 | V1 Scenario 改為：side-effect 只執行一次不得放寬；第二次 resume 的 HTTP 回應、run 狀態與 rejected audit 與既有 `langgraphjs dev` 對照一致；兩者皆未拒絕時記錄為既有產品規格缺口。產品缺口（replayed resume 依 `durable-hitl-conversation-recovery` 應拒絕並 audit）列為後續 Change，不在本 Change 修改 |

修改改變 Scenario 語意，送 Qwen 重新 review-plan（005）。已通過的 task 1.1、2.0 與相關 evidence 保留。

apply-change 003 仲裁（attempt 6）：`implementation-result-apply-003` 為 partial，task 2.1 V1 對照通過（兩邊重放皆 no-op、rejected audit 皆為 0、side-effect 各一次）。V2(a) 出現 F004：interrupt 建立後約 0.8 秒 SIGKILL，新 thread 的 7 個 checkpoint、兩則訊息與等待中 interrupt 全部遺失，最早遺失資料年齡約 4.8 秒；三項硬性不變量未失敗。

| Finding | 判定 | 處理 |
| --- | --- | --- |
| F004 寫檔延遲不提供資料年齡上限 | 成立，屬真實行為差異，不是 Scenario 前提錯誤。開源 server 的寫檔延遲在每次存取後重新計時，持續活動期間不寫檔，SIGKILL 會遺失整段尚未落盤的活動；SIGTERM 結束前會寫檔，已由 V0、V1 實測保留 | Master 於 2026-11-18 附條件接受：(1) V2 可接受遺失範圍改為「最近一次連續至少一個寫檔延遲期間沒有存取之後的全部活動」，並記錄實測範圍與年齡；(2) 三項硬性不變量不放寬，三個時點都須通過，V2(c) 須證明 checkpoint 遺失後再次核准不產生第二次 side-effect；(3) V5 記錄最長未寫檔間隔；(4) 部署 Change 須加入停止緩衝時間與記憶體上限及監控，降低 SIGKILL 機率（不在本 Change 實作） |

修改改變 V2 通過標準與 Scenario 語意，送 Qwen 重新 review-plan（007）。V2(a) 既有證據依新標準重新判定，不需重跑。`review-result-review-plan-007` 為 APPROVE（0 Blocker／0 Major／1 Minor），evidence gate 通過；Minor（tasks 第 6 節未列部署防護）採納，已補列，屬追溯性補充，不需重新審查。

attempt 2 起的 review prompt 改以 design D-4 的 Requirement 清單作為 `durable-hitl-conversation-recovery` 的依據，不再要求 reviewer 讀取該檔，以避開偵測誤判；adapter 偵測規則的調整列為後續建議（屬工具程式，由 Codex 處理）。
