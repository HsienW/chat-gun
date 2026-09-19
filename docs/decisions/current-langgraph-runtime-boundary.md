# Current LangGraph Runtime Boundary（X11 Decision Record）

- Change：`reverify-current-langgraph-runtime-boundary`（X11）
- 盤點日期：2026-09-17；Docker 啟動續驗：2026-09-18；`langgraph dev` live spike：2026-09-18–19
- 狀態：**Qwen `review-result` 已判定 APPROVE（0 Blocker、0 Major）；CCR `readiness-check` 已判定 READY_TO_ARCHIVE，可作為 X12 架構前置證據。**
- 範圍：目前四個 Graph 在 `langgraph dev` 的生命週期與責任邊界；`docker-compose.yml` 僅作靜態背景，本 Change 不修改 application code。

## 驗收範圍與證據等級

| 等級 | 意義 |
| --- | --- |
| S | 直接檢查此版 repository 的原始碼或設定；只證明靜態結構。 |
| D | LangChain 官方文件所描述的 Agent Server 行為；不是此部署的實測。 |
| L | 此版 Docker Agent Server、PostgreSQL、Redis 的 live 輸出。現有 L 證據僅涵蓋映像建置、Server 啟動失敗與資料庫 schema；**沒有 Run、checkpoint 寫入或 resume 的 L 證據**，且不屬本 Change 的驗收條件。 |
| V | `backend` 的 `langgraph dev` 開發伺服器實測；是本 Change 的動態驗收證據，只能證明本機 API／Thread／State 行為。 |

本 Change 以 V 作為動態驗收標準；**V 不升格為 L**。2026-09-18 Docker daemon 曾可用，但 Agent Server 因 Dockerfile 與授權問題未就緒，所以沒有該部署的 Run、checkpoint 寫入、resume、cancel 或 worker lease 實測。Compose 的 `langgraph-api` 只有 `expose: 8000`，沒有 host `ports`；未來 L 驗證須記錄從容器網路或 BFF 進入 API 的實際路徑。下列 Docker 結果只保留作為移出範圍的原因，不是本次動態驗收失敗。

### 2026-09-18 Docker 續驗（L；啟動層級）

| 操作／觀察 | 實際結果 | 結論界限 |
| --- | --- | --- |
| `docker version`、`docker compose ps --format json` | daemon 可用；續驗前僅 PostgreSQL 16 容器運作且健康。 | Docker 障礙解除。 |
| `docker compose --progress quiet up --build -d langgraph-postgres langgraph-redis langgraph-api` | `Dockerfile:23` 的 `npm install --omit=dev` 失敗：`postinstall` 要執行 `patch-package`，但該套件位於 devDependencies，exit 127。 | **原版 Dockerfile 不能建置此版 Agent Server。** 本 Change 不修改 infra 設定。 |
| 使用本機 `.agent-runtime/reverify-current-langgraph-runtime-boundary/evidence/Dockerfile.live-spike` 建置測試映像 | 只把上述步驟改為 `npm install`；測試映像 ID `sha256:ae5f4bfe0905e95bd30f91805f122f1f724e59265b081a6cc3aa0c152b1b5ad9`，base image `langgraphjs-api:20` digest `sha256:f1ea05f53f6032681c9cc77e6f482a53c7c704ad17146b29e4113f47343ebf98`。 | 這是暫時測試映像，與原版 Dockerfile 的依賴安裝範圍不同；不能宣稱原版 Compose 建置成功。 |
| `docker compose --progress quiet up --no-build --pull never -d ...` | PostgreSQL、Redis 健康；Agent Server 連入 PG、執行 migration，日誌標示 `langgraph-api=0.14.1`，但容器以 exit code 3 退出。 | Server 尚未提供 API。 |
| 從 `backend/.env` 在單次程序載入非空 `LANGSMITH_API_KEY` 後重啟 API | license endpoint 回 `403 Forbidden`；`License verification failed`，容器仍以 exit code 3 退出。未輸出或保存 key。 | 此次未證明 key 已進入容器；後續以容器設定逐項比對。 |
| 用本機無密鑰 Compose override 直接載入 `backend/.env`，強制重建 `langgraph-api` | 逐項比對確認容器內 `LANGSMITH_API_KEY` 與檔案最後一筆相同且非空；`GET https://api.smith.langchain.com/auth?langgraph-api=true` 仍回 `403 Forbidden`，Agent Server `exit 3`。 | 已排除 key 未傳入容器；但 `403` 本身不能區分 key 無效、帳戶缺少 Agent Server 存取權或其他授權限制。Run 層級仍未驗證。 |
| `information_schema.tables` 與 `SELECT count(*)` | Server migration 建立 `checkpoints`、`checkpoint_blobs`、`checkpoint_writes`、`run`、`thread`、`store` 等表；前三個 checkpoint 表及 `run` 表均為 **0 筆**。 | 證明 server-side checkpoint schema 與 ingestion loop 初始化；**不證明任何 Graph State 已持久化**。 |

上述 Docker 摘要另見本機授權續驗證據 `.agent-runtime/reverify-current-langgraph-runtime-boundary/evidence/license-attempt-2026-09-18.md`。Docker 部署沒有建立測試 Thread 或 Run，也沒有變更 PostgreSQL 中既有的 Chat-Gun Task 資料。Dockerfile 依賴安裝與 LangSmith 授權須由後續 Change 處理。

### 2026-09-18–19 `langgraph dev` live spike（V；本機開發模式）

使用既有 `backend/package.json` 的 `langgraphjs dev --no-browser`（`@langchain/langgraph-cli` 1.4.5）啟動 `http://localhost:2024`。啟動輸出明示這是 in-memory development server；四個 Graph 均註冊成功。`backend/langgraph.json` 的 `env` 指向 `backend/.env`。本次未輸出 key，也未向 Docker Agent Server 注入新授權。

| 操作／觀察 | 實際結果 | 結論界限 |
| --- | --- | --- |
| 對既有 `worker-queue-signal.live-spike.test.ts` 設定 `LANGGRAPH_SPIKE_BASE_URL=http://localhost:2024` 後執行 | 1/1 通過；Run／Thread API 回傳狀態與時間欄位，公開回應沒有 claim／lease／heartbeat 欄位。 | 僅證明開發伺服器的公開 API；不證明 Docker worker lease 實作。 |
| `chatbot`（無 explicit checkpointer）空訊息建立 Thread 與 Run，使用 `interrupt_before: "*"` | Thread 為 `interrupted`；state 的 `next=["chat_response"]`、訊息數 0、history 2 筆。9/19 重跑的 `checkpoint_id=1f1b4042-75b4-6dc0-8000-1dbf7a0a1468`、`checkpoint_ns=""` 在正常重啟前後不變。 | 證明 V 模式在 node 前保存可讀 checkpoint；尚未執行 graph node。 |
| 正常停止 `langgraph dev`，重新啟動後讀取同一 Thread | Thread 仍為 `interrupted`、`checkpoint_id` 不變、history 仍 2 筆。 | 證明本次開發模式跨正常重啟保留該 State；不等於強制終止或 PostgreSQL durability。 |
| `POST /threads/{thread_id}/runs/wait`，`input: null` 恢復 | Thread 變為 `idle`；`next=[]`、訊息數 1、history 3 筆，checkpoint ID 更新為 `1f1b4044-0bfb-6350-8001-f0c9f927547e`。 | `chatbot` 空訊息走內建回覆路徑，未呼叫模型或外部 Tool；可證明 V 模式恢復一次，但不證明有副作用時不重複。 |
| 對新 Thread 呼叫 `POST /threads/{thread_id}/runs/stream`，`stream_mode: "values"` | HTTP 200，SSE event 依序為 `metadata`、`values`、`values`；最終 Thread `idle`、訊息數 1、history 3 筆。 | 證明 V 模式串流 API；沒有 Docker／Redis stream 證據。 |
| `deep_researcher`（explicit `MemorySaver`）以無效圖片 URL 輸入，在 `validate_uploads` 後中斷 | Thread `interrupted`、`next=["synthesize_answer"]`，`uploadError` 存在、訊息數 1、history 3。9/19 重跑的 `checkpoint_id=1f1b4042-77f7-6790-8001-ff3629a28568`、`checkpoint_ns=""` 在正常重啟前後不變；State 保留 `messages`、`uploadError`、`searchResults` 等 10 個欄位名稱。 | 驗證節點已執行；輸入故意走錯誤分支，不進研究模型或 Tool。 |
| 正常重啟後恢復同一 `deep_researcher` Thread | 重啟後 checkpoint ID、`uploadError` 與 State 欄位不變；`input:null` 恢復後 Thread `idle`、訊息數 2、history 4，checkpoint ID 更新為 `1f1b4044-141b-6490-8002-ea84b6eb2a7c`。 | V 模式可還原本次 State；不能歸因為 `MemorySaver` 或 server storage 的單一機制，也沒有副作用重播證據。 |
| `math_agent` 以純計算輸入在 `call_model` 前中斷、正常重啟、恢復 | 重啟前後 Thread `interrupted`，`checkpoint_id=1f1b4028-c591-6a60-8000-fd2e539882a2`、`checkpoint_ns=""`、history 2 均不變；resume Run `success`，Thread `idle`、history 3，checkpoint 更新為 `1f1b402b-19b8-6650-8001-2e94378bfdc5`。 | Graph 無 explicit checkpointer；dev runtime 提供可讀 state／history 與正常重啟恢復。該路徑只用純計算 Tool，無外部提交。 |
| `mcp_agent` 在 `call_model` 前中斷、正常重啟、恢復 | 重啟前後 Thread `interrupted`，`checkpoint_id=1f1b4028-c746-6a90-8000-c1824efe300f`、`checkpoint_ns=""`、history 2 均不變。第一次 resume 因模型連線 `TypeError: fetch failed` 而 Run `error`，checkpoint 未變；在沙箱外重啟同一 dev 命令後，原 Thread 的下一次 resume Run `success`，Thread `idle`、訊息數 2，checkpoint 更新為 `1f1b402e-91cd-6070-8001-fc4edec87b99`。 | 證明錯誤 Run 未推進 checkpoint、相同 Thread 可重試；不能由此證明 Tool 副作用的冪等性，也不能把第一次失敗隱藏。 |
| 獨立 `cancel_probe` fixture：執行中的 Run 取消與 terminal lookup | 僅有 15 秒可中止計時器的 Graph 在 `http://localhost:2025` 啟動；取消前 Run `running`、Thread `busy`；`POST /threads/{thread_id}/runs/{run_id}/cancel?wait=1&action=interrupt` 回 204；取消後及再查詢時 Run 都是 `interrupted`，Thread `idle`。 | 證明 dev API 對可取消中的無副作用 Run 的 cancel 行為；此 fixture 不是四個正式 Graph，未證明 Tool 或模型請求取消後的外部狀態。先前對已 `success` Run 呼叫 cancel 亦回 204，但不計入有效 cancel 證據。 |
| 清理本輪測試 Thread | `chatbot`、`deep_researcher`、`math_agent`、`mcp_agent` 與 `cancel_probe` Thread 的 DELETE 均回 204；前次 stream Thread 亦已清理。 | 測試資料限於開發伺服器；未動既有 PostgreSQL Task 資料。 |

前次證據摘要見 `dev-live-attempt-2026-09-18.md`。本輪可重播腳本與經遮罩輸出在同一 change 的本機 evidence：`dev-graph-a-spike.mjs`／`dev-graph-a-spike.json`／`dev-chat-deep-spike.json`、`dev-cancel-fixture.mjs`／`dev-cancel.langgraph.json`／`dev-cancel-spike.mjs`／`dev-cancel-spike.json`。上表 `chatbot` 與 `deep_researcher` 的 resume checkpoint ID 取自 2026-09-19 `dev-chat-deep-spike.json` 各案例的 `afterResume.checkpointId`；該檔同時記錄 `beforeRestart`、`afterRestart` 與 resume Run ID，作為同一次執行的 provenance。記錄只保留 Thread／Run／Checkpoint ID、狀態、欄位名稱及計數，不保存訊息內容或憑證。V 證據支持四個 Graph 在此次 dev 模式的 interrupt 與正常重啟；其中 `mcp_agent` 的成功 resume 是沙箱外重試所得。V 不能區分 `deep_researcher` 的 Graph-level `MemorySaver` 與 dev runtime storage 的內部優先序，更不能分類它與正式 Agent Server 持久化的 override／complement／conflict 關係。

### 本次實際驗證

| 命令 | 結果 | 對結論的限制 |
| --- | --- | --- |
| `npm run lint`（backend） | 通過 | TypeScript 靜態檢查，不驗證 Server 行為。 |
| `npm run build`（backend） | 通過 | 此套件以 `tsc --noEmit` 執行 build；不建立容器。 |
| `npm run test -- src/operations/manifest.test.ts src/operations/recovery/worker-recovery.test.ts src/runtime/state-machine.test.ts src/runtime/side-effect/business-effect-ledger.test.ts` | 4 檔、66 tests 通過。 | deterministic 邏輯，非 live drill。 |
| `npm run test -- src/operations/__spike__/worker-queue-signal.live-spike.test.ts` | 1 檔、1 test skipped（未設定 `LANGGRAPH_SPIKE_BASE_URL`）。 | 不是 Agent Server 證據。 |
| `npm run test`（backend，與 lint／build 並行的第一次） | 928 passed、2 failed、45 skipped；`llm-gateway-fallback.test.ts` 一例逾時、一例 mock 呼叫次數不符。 | 不把失敗隱藏或稱作通過。 |
| `npm run test -- src/platform/llm-gateway-fallback.test.ts` | 6/6 通過。 | 同檔單獨重跑未復現失敗。 |
| `npm run test`（backend，單獨重跑） | 930 passed、45 skipped。 | 第一次失敗可能與併行資源競爭有關，原因未定；與本文件變更無直接關聯。 |
| PowerShell：`$env:LANGGRAPH_SPIKE_BASE_URL='http://localhost:2024'; npm run test -- src/operations/__spike__/worker-queue-signal.live-spike.test.ts` | `langgraph dev` 下 1/1 通過。 | V 證據；原 Docker 部署的 live spike 仍未執行。 |
| `npm run test -- src/operations/manifest.test.ts src/operations/recovery/worker-recovery.test.ts src/runtime/side-effect/business-effect-ledger.test.ts` | 3 檔、14/14 通過。 | deterministic 分類與 ledger 邏輯；未執行 process kill 或 infra 故障。 |
| 2026-09-19：`npm run dev -- --no-browser`（backend） | `http://localhost:2024/ok` 回 200，四個 Graph 註冊成功；正常停止與重啟各一次。 | V，僅本機開發伺服器。 |
| 2026-09-19：`dev-graph-a-spike.mjs prepare`／正常重啟／`resume`／`cleanup` | `chatbot`、`deep_researcher`、`math_agent` 完整成功；`mcp_agent` checkpoint 跨重啟保留，第一次模型連線失敗，沙箱外重試成功；四個 Thread 清理皆 204。 | V；mcp 的失敗與重試須一起解讀。 |
| 2026-09-19：`dev-cancel-spike.mjs`（獨立 `cancel_probe` dev server） | Run 在 `running` 時 cancel 回 204；兩次 terminal lookup 都是 `interrupted`；Thread `idle`，清理 204。 | V；fixture 沒有模型、Tool 或外部副作用。 |
| 2026-09-19：live `worker-queue-signal.live-spike.test.ts` | 1/1 通過。 | V，公開 Run／Thread API 不包含 worker lease／heartbeat。 |
| 2026-09-19：`manifest.test.ts`、`worker-recovery.test.ts`、`business-effect-ledger.test.ts` | 3 檔、14/14 通過。 | S 加 deterministic test；不是部署重啟或故障注入的 live drill。 |
| 2026-09-19：`npm run lint`（backend） | 通過。 | TypeScript 靜態檢查，不驗證正式 Server 行為。 |
| 2026-09-19：`npm run test`（backend，單獨執行） | 135 檔通過、5 檔 skipped；930 passed、45 skipped。 | 全量 deterministic／mock 回歸；skipped 不視為 live 通過。 |
| 2026-09-19：`npm run build`（backend） | 通過；此套件以 `tsc --noEmit` 執行。 | 不建立 Docker 映像。 |

2026-09-18 的第一次全量測試曾有 2 個未復現的失敗，表內如實保留；2026-09-19 本輪順序執行 lint、全量測試、build，皆通過。`git diff --check` 與未追蹤文件的空白檢查須在交接前再執行。沒有 Run 層級的 L 證據；Docker 續驗只取得啟動與 schema 證據。

## 版本與部署盤點（S）

| 項目 | 此版 repository 的證據 | 已確認範圍 |
| --- | --- | --- |
| Graph 套件 | `backend/package.json` 固定 `@langchain/langgraph` 1.4.14、`@langchain/langgraph-checkpoint` 1.1.5、`@langchain/langgraph-checkpoint-postgres` 1.0.5、`@langchain/langgraph-cli` 1.4.5。 | 宣告版本；未確認容器內實際安裝版本。 |
| Agent Server image | `Dockerfile` 的 `langgraph-api` stage 以 `docker.io/langchain/langgraphjs-api:20` 為 base。 | 續驗取得 base digest `sha256:f1ea05f53f6032681c9cc77e6f482a53c7c704ad17146b29e4113f47343ebf98`；啟動日誌顯示 API `0.14.1`，但服務未 ready。 |
| Graph 註冊 | `backend/langgraph.json` 註冊 `deep_researcher`、`chatbot`、`math_agent`、`mcp_agent`；`Dockerfile` 的 `LANGSERVE_GRAPHS` 也列出同四個 ID。 | 四者在 `langgraph dev` 註冊成功（V）；Docker Agent Server 未 ready（L）。 |
| HTTP 傳遞 | `backend/langgraph.json` 的 `http.configurable_headers.includes` 列出 `x-request-id`、`x-idempotency-key`、`x-active-run-id`、`x-active-run-generation`；`env` 指向 `.env`。 | 只確認設定宣告，不推論已在所有 Run 生效。 |
| Infra | `docker-compose.yml` 定義 `langgraph-api`、PostgreSQL 16、Redis 6；API service 提供 `POSTGRES_URI` 與 `REDIS_URI`，PG 有 volume 與 healthcheck。 | 只確認配置，不等於服務啟動、連線或建表成功。 |

### 四個 Graph 的 compile 呼叫（S）

| Graph ID | 原始碼 | compile / checkpointer |
| --- | --- | --- |
| `chatbot` | `backend/src/agents/chatbot.ts:53` | `builder.compile()`，無 explicit checkpointer。 |
| `math_agent` | `backend/src/agents/math-agent.ts:79` | `builder.compile()`，無 explicit checkpointer。 |
| `mcp_agent` | `backend/src/agents/mcp-agent.ts:72` | `builder.compile()` 後包上 Opik instrumentation，無 explicit checkpointer。 |
| `deep_researcher` | `backend/src/agents/deep-researcher.ts:5,2918-2923` | `new MemorySaver()` 傳入 `builder.compile({ checkpointer })`；Graph 程式碼另有 `interrupt()`，見同檔 `:1869`。 |

「無 explicit checkpointer」**不等於**「在 Agent Server 無持久化」。[LangGraph JS 官方 Persistence 文件](https://docs.langchain.com/oss/javascript/langgraph/persistence) 說 Agent Server 自動處理 checkpointer／store 基礎設施，且 `MemorySaver` 本身不跨 process restart。[LangSmith data plane 文件](https://docs.langchain.com/langsmith/data-plane) 說 PostgreSQL 是預設 checkpoint backend、保存 threads／runs 等 server 資源，Redis 承擔 worker 通訊與暫時性 metadata。這些是 D 證據；`langgraphjs-api:20` 對這四個 Graph 的注入、覆寫、State 範圍、表名與恢復粒度仍須 L 驗證。

## 既有 Chat-Gun 原語與聲稱責任（S）

| 原語 | 程式碼依據 | 聲稱責任；與 native 的關係待 live 核對 |
| --- | --- | --- |
| Task／Step State Machine 與持久化 | `backend/src/runtime/types.ts`、`state-machine.ts`、`persistence/task-repository.ts`、`step-repository.ts` | 業務 Task／Step 狀態及合法轉移；不同於 Graph node checkpoint。 |
| Retry Budget | `backend/src/runtime/retry/retry-budget.ts`、`retry-executor.ts` | 業務 step 的 attempt／耗時預算；須與 Server 自身 transient failure retry 區分。 |
| Idempotency／Audit | `backend/src/runtime/idempotency/idempotency-guard.ts`、`audit/audit-events.ts` | 業務去重鍵、決策審計；不由 Run 重放自動保證。 |
| Compensation | `backend/src/runtime/compensation/saga-orchestrator.ts` | 已提交副作用的補償與失敗記錄。 |
| Distributed Step Lock | `backend/src/runtime/lock/step-lock.ts`、`step-transition-guard.ts` | 業務 Step 的互斥與狀態 CAS；不能拿來宣稱取得 Agent Server worker lease。 |
| Side-effect Ledger | `backend/src/runtime/side-effect/business-effect-ledger.ts` | ToolExecution、business effect、commit／unknown／compensation 事實。 |
| Interaction Runtime | `backend/src/runtime/interaction/ownership.ts`、`backend/src/platform/interaction-runtime.ts` | 可見 Run 的 scope、generation、CAS 與取消／取代政策。 |
| Context Budget | `backend/src/context/context-budget.ts` | 注入模型前的內容配置與 token 預算。 |
| Long-term Memory Governance | `backend/src/memory/governance/memory-governance-service.ts`、`memory/store/postgres-adapter.ts` | 授權、scope、history、provenance 與儲存 adapter；Store 僅提供跨 Thread 資料機制。 |
| Operations | `backend/src/operations/recovery/worker-recovery.ts`、`reaper.ts`、`drain.ts`、`manifest.ts`、`canary.ts`、`quality-gate.ts`、`release-gate.ts` | 依 native／業務訊號分類 recovery、相容性、drain 與上線 Gate；不是第二套通用 Run queue。 |

既有 `backend/src/operations/__spike__/worker-queue-signal.live-spike.test.ts` 建立 Thread、以 `interrupt_before: "*"` 建立 Run，讀取 Run／Thread 的 status 與時間欄位，並檢查公開回應沒有 claim／lease／heartbeat 欄位。它在未設定 `LANGGRAPH_SPIKE_BASE_URL` 時會 `skip`；本次已在 `langgraph dev` 下執行為 V 證據，**尚未**在 Docker Agent Server 上執行為 L 證據。該測試本身也未涵蓋 restart、resume、cancel 或 PG checkpoint 查詢。

## `MemorySaver` 與 Server-managed persistence 的界限

官方文件支持「Agent Server 會管理持久化」及「PostgreSQL 是預設 checkpoint backend」的設計假設（D）。2026-09-18 的 L 證據確認 API `0.14.1` 的 Postgres runtime 建立 checkpoint 表並啟動 ingestion loop；授權失敗使它在接受 Run 前退出，checkpoint 三表與 `run` 表仍是 0 筆。V 證據確認無 explicit checkpointer 的三個 Graph 與有 `MemorySaver` 的 `deep_researcher`，在此次 dev 模式中均可讀取 Thread state／history、跨正常重啟保留 checkpoint。可觀察粒度包括 node 前的 interrupt checkpoint，以及 `validate_uploads` node 後的 checkpoint；history 在成功 resume 後各增加一筆，不能據此概括所有路徑的寫入粒度。這證明 dev runtime 提供了可觀察的 Thread 持久化，但不能從黑箱結果判定其內部注入與 `MemorySaver` 的優先序，也不能推論**此 image／此 Compose／此 Graph**會寫入 PostgreSQL。`MemorySaver` 相對正式 server-managed persistence 的 override／complement／conflict 分類為**未驗證（超出 langgraph dev 範圍）**。處置是**暫時保留現況，不做 migration 或移除**；後續 L 對照後再決定保留、移除或隔離到測試。

後續 Change 至少要在正式 Agent Server 上以兩類 Graph 對照：interrupt 前後查 Thread state／history 與 PG 實際 checkpoint 列，記錄 `checkpoint_id`、`checkpoint_ns`、State 欄位摘要與寫入時間；重啟 `langgraph-api` 後以同一 Thread resume，確認 State 與副作用，再核對 Run status 與 ID。查表前先列出實際 schema。測試資料使用無外部副作用或可驗證冪等的 Tool，不保存完整 prompt、憑證與敏感輸出。

## Native 訊號到 Chat-Gun 概念的映射

| Native 訊號 | Chat-Gun 對應 | 分界與證據等級 |
| --- | --- | --- |
| Queue／Worker | Operations 的進度觀測與 recovery 分類 | dev 的公開 Run／Thread 狀態可觀測（V），未暴露 claim／lease／heartbeat；正式 Server 背景 worker 與 Redis 行為是 D，**此部署未驗證**。Chat-Gun 不自建通用 queue。 |
| Run／Thread | Interaction ownership 的 `runId`、`threadId` 與可見 generation | dev 回傳獨立 Run ID／status 與 Thread ID／status（V）；例如 `interrupt_before` 後 Run 可為 `success` 而 Thread 為 `interrupted`，取消後 Run 為 `interrupted` 而 Thread 為 `idle`。scope／generation CAS 是 Chat-Gun 業務語義（S）。 |
| Checkpointer | ExecutionManifest、resume compatibility、Task 關聯 | 四 Graph 的 Thread state／history 與 checkpoint identity 在 dev 正常重啟後可讀（V）；相容性政策見 `backend/src/operations/manifest.ts`（S）。正式持久化來源待 L。 |
| Store | Long-term Memory Governance | Store 是跨 Thread 資料機制（D）；授權、namespace、history、provenance 在 Chat-Gun（S）。 |
| Graph node／step | 業務 Task／Step | native node execution 不含 `backend/src/runtime/types.ts` 所定義的業務狀態與審計（S＋D 的責任分析；未實測端到端）。 |

### 責任歸屬表（已通過獨立 review-result）

| Capability | Authority 與證據等級 | Chat-Gun extension／補原生缺口的依據 | Failure owner |
| --- | --- | --- | --- |
| Run queue／worker assignment | LangGraph native dev Run 排程（V）；Docker Agent Server worker assignment／lease **未驗證**（D 只能作假設）。 | 只觀測 Run／Thread 訊號與分類；不自建通用 queue。`worker-queue-signal.live-spike.test.ts` 的 V 結果沒有 lease／heartbeat 欄位。 | dev Run API 故障歸 Backend／LangGraph runtime；正式 worker 故障歸 Agent Server，Operations 觀測與升級。 |
| Graph checkpoint／interrupt | LangGraph dev runtime（V：四 Graph 中斷後的 state／history、正常重啟與 resume）；正式 Server-managed PG persistence **未驗證**。 | `manifest.ts` 定義版本相容政策與業務關聯；不複製 checkpoint。 | Backend／LangGraph runtime；正式 PG 故障歸 Agent Server，待 L 確認。 |
| 業務 Task／Step 狀態 | Chat-Gun（S） | `types.ts`、`state-machine.ts` 定義業務轉移與 `task-repository.ts` 持久化。 | Backend。 |
| 可見 Run generation | Chat-Gun interaction runtime（S） | `ownership.ts` 的 scope／generation CAS；與 native Run ID 相關但語義不同。 | Backend。 |
| Side-effect commit truth | Tool adapter／Chat-Gun ledger（S；真實外部提交未驗證）。 | `business-effect-ledger.ts` 分開 prepared、committed、unknown；Graph checkpoint 不能證明外部系統是否提交。 | Tool adapter；Operations 執行 reconciliation。 |
| 長期記憶 | LangGraph Store 機制（D）＋ Chat-Gun governance（S） | `memory-governance-service.ts` 處理授權、scope、history、provenance。 | Backend／Store adapter。 |
| Worker recovery 決策 | Chat-Gun 分類政策（S）使用 LangGraph Run／Thread 訊號（V）；正式 Server retry／lease **未驗證**。 | `worker-recovery.ts`、`reaper.ts` 根據 side effect 與 replay safety 決定 requeue／park／reconcile；未證明已接上正式 worker。 | Operations；正式 Server 本身故障歸 Agent Server。 |
| Server-managed PostgreSQL／Redis persistence | **未驗證（超出 langgraph dev 驗收範圍，另立後續 Change）**。 | 不以 V 的 checkpoint 結果推論正式資料庫寫入。 | 待 L 確認；預期 Agent Server／infra。 |

上述歸屬是本 Change 的 dev 與靜態邊界判定，已通過獨立 review-result；不得以官方文件推斷此 Docker 部署的實際 worker lease、retry 或 resume 行為。`worker-recovery.ts` 是**分類函式**；單看原始碼不能宣稱已與正式 Server worker 完整整合。

## Identity ownership 與權威來源

| Identity／狀態 | 應取的權威來源 | 目前證據與限制 |
| --- | --- | --- |
| Run ID／Run status | Run API 的 `run_id`／`status`，以 `thread_id` 關聯；Thread status 另由 Thread API 取得。 | V 模式取得 create／resume／cancel 的機器 ID 與狀態；Run `success` 可與 Thread `interrupted` 並存，不能用 Thread 或訊息文案反推 Run status。Docker 部署未實測。 |
| checkpoint identity | Thread state／history 的 `checkpoint_id`、`checkpoint_ns`。 | V 模式四 Graph 的 checkpoint ID 跨正常重啟不變、resume 成功後更新；本輪 `checkpoint_ns=""`。PG 列對照未驗證。 |
| Task ID／Step ID | Chat-Gun Task／Step repository。 | `backend/src/runtime/types.ts` 與 repositories（S）。 |
| ToolExecution／business effect ID | Chat-Gun side-effect ledger，並對外部 operation ID reconciliation。 | `business-effect-ledger.ts`（S）；外部提交真相需下游回查。 |
| 可見 Run generation | Chat-Gun active ownership repository 的 `generation`。 | `ownership.ts`（S）；不改寫 Server Run ID 或 status。 |
| resume compatibility | `backend/src/operations/manifest.ts` 的 machine-readable manifest 欄位與 `compatible`／`migratable`／`incompatible` 決策。 | S＋`manifest.test.ts`；manifest 是否已隨這四個 Graph 的 checkpoint 保存，以及正式部署如何執行 gate，未驗證。不得用顯示文案或模型輸出推斷。 |

## Failure drills：六項分類與證據

以下逐項記錄本 Change 可得的 V／S 證據與無法演練的界限。`langgraph dev` 的正常停止不是強制 process kill；沒有真實外部提交的實測，也沒有正式 PG／Redis 故障注入。Replay safety 必須同時看 checkpoint、ledger 與外部系統的提交事實。

| Drill | 實證等級與結果 | Replay 分類 | Failure owner |
| --- | --- | --- | --- |
| 1. first checkpoint 前 process 終止 | **未驗證**；本輪最早可讀狀態已是 interrupt checkpoint，未在此之前終止程序。 | 僅在未 dispatch 外部副作用時可視為 replay-safe 候選；若已有 effect attempt 則是 side-effect ambiguity。 | dev runtime／Backend；正式環境預期 Agent Server，有 effect 時 Tool adapter／Operations。 |
| 2. 等待 interrupt 期間 process 終止 | **V：正常停止後重啟**。`chatbot`、`deep_researcher`、`math_agent`、`mcp_agent` 的同一 Thread 保留 checkpoint ID 與待執行節點；恢復後成功的 Run 產生新 checkpoint。**強制 kill durability 未驗證**。 | 本次無外部未提交 effect 的輸入可安全 resume；有 effect 時須先 reconciliation，不泛化為 replay-safe。 | dev runtime／Backend；正式環境預期 Agent Server。 |
| 3. Tool dispatch 後、Tool result 持久化前 process 終止 | **未驗證**；`deep_researcher` 錯誤分支未呼叫研究 Tool，`math_agent` 純計算路徑沒有外部提交。 | **side-effect ambiguity**；不得盲目 replay，先查 ledger prepared／unknown、下游 operation ID 與提交事實。 | Tool adapter／Operations。 |
| 4. compatible manifest 的部署重啟 | **S＋deterministic test**：`manifest.ts` 與 `manifest.test.ts` 的分類邏輯已重跑；未部署重啟，manifest 是否在 checkpoint 內未驗證。 | 僅在 manifest compatible 且無未核對 effect 時 replay-safe；否則 park／reconcile。 | Backend／Operations。 |
| 5. incompatible manifest 的部署重啟 | **S＋deterministic test**：`manifest.ts` 對 incompatible 的判定已重跑；未部署重啟。 | **不准直接 replay**；pin 舊環境或 park，待 migration／人工處置。 | Operations／Backend。 |
| 6. resume 期間 PostgreSQL 或 Redis 不可用 | **未驗證（超出 langgraph dev 驗收範圍）**；dev 不使用此 Compose 的正式 PG／Redis 路徑。 | 在 Run 與 effect 真相釐清前不視為 replay-safe；可能有 side-effect ambiguity。 | 正式 Agent Server／Operations；effect 交 Tool adapter。 |

`manifest.test.ts`、`recovery/worker-recovery.test.ts`、`business-effect-ledger.test.ts` 本輪共 14/14 通過，只覆蓋 deterministic 分類與 ledger 邏輯，不能改稱六項 live drill 均已通過。

## 決策、未驗證清單與下一個 Gate

1. 本 Change 的 V 實證支持：四個 Graph 在此次 `langgraph dev` 可讀 Thread state／history、在 interrupt 等待期間跨**正常停止後重啟**保留 checkpoint；無副作用 fixture 的執行中 Run 可取消，terminal lookup 為 `interrupted`。Run 與 Thread 的 status 各有自己的 API 權威來源。
2. Chat-Gun 保留業務 Task／Step、可見 generation、side-effect ledger、記憶治理及 recovery **決策**；LangGraph native 管理 dev Run／Thread／Graph checkpoint API。上述自建能力的依據是對應的型別、狀態機、repository、ledger 與 policy 原始碼（S），不是推測 native 自動處理業務語義。
3. **未驗證（超出 langgraph dev 驗收範圍，另立後續 Change）**：正式 Server-managed PostgreSQL／Redis persistence、Graph-level `MemorySaver` 與 Server checkpointer 的 override／complement／conflict 關係、Docker worker lease／heartbeat、強制 process kill durability、正式 Run 的 checkpoint 寫入與恢復、PG／Redis 故障注入。
4. **本 Change 仍未實證**：first checkpoint 前終止、Tool dispatch 與結果持久化間的真實副作用故障、manifest 隨 checkpoint 保存及正式部署重啟。這些只能保留 S 分類或未驗證，不得升格為 V／L。
5. 此 Decision Record 已經 Qwen 獨立 `review-result` 通過，可作為 X12 的架構前置。X12 起任何正式部署持久化決策，須明示「基於未驗證假設」，直到後續 Change 取得 L 證據。
