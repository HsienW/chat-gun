# 本機自建 runtime spike

本目錄供 `spike-mit-langgraph-server` 的本機驗證使用。task 1.1、V0／V1 沿用既有證據；apply-004 依 attempt 6 的新邊界完成 V2～V5，現況以 findings.md 與 CurrentState 為準。完整結果與未驗證項目見本 Change 的 findings.md。

## 映像與啟動

從 repository 根目錄執行：

```powershell
docker compose --env-file .env --file deploy/self-hosted-runtime/compose.yaml config --quiet
docker compose --env-file .env --file deploy/self-hosted-runtime/compose.yaml build
```

`config --quiet` 避免輸出展開後的私有設定。靜態結構檢查可使用 `config --no-interpolate --no-env-resolution --quiet`。

基底固定為 Dockerfile 內的官方 Node LTS digest，本次實測 Node 為 `v26.13.1`。API 與 CLI 均由既有 backend lockfile 鎖定為 `1.4.5`。安裝使用 `npm ci --include=dev --ignore-scripts`，略過既有的 patch-package postinstall，沒有修補套件或變更 lockfile。

實際啟動命令：

```text
node --import tsx /app/backend/start-runtime.mjs
```

薄入口讀取原 `langgraph.json`，交由套件公開的 `StartServerSchema` 與 `startServer` 啟動，沿用套件回傳的 cleanup 與 3 秒 exit hook。沒有替代 checkpointer 或自訂儲存層。監聽位址、埠及 worker 數分別由 `RUNTIME_HOST`、`RUNTIME_PORT`、`RUNTIME_WORKERS` 提供。

使用公開 API 入口的原因是 CLI 路徑已重現 Node 參數及 IPC Schema 錯誤；兩個失敗均保留於 evidence。現行入口可載入五個 graph，但不能據此推定 run、恢復或 UI 相容性通過。

## 本機私有設定

價格、額度與憑證由執行時環境提供，本目錄沒有部署用的數值預設值。

| 類別 | 設定 |
| --- | --- |
| 模型 | `LLM_PROVIDER`、`QWEN_API_KEY`、`QWEN_BASE_URL` 與 `QWEN_*_MODEL`／既有 model 設定 |
| 研究工具 | 所需的 `TAVILY_API_KEY`、`BRAVE_API_KEY` |
| 帳本 | `USAGE_LEDGER_TIME_ZONE`、`USAGE_LEDGER_WRITE_TIMEOUT_MS`、`USAGE_PRICE_TABLE_JSON` |
| Demo | `DEMO_SESSION_SECRET`、`DEMO_SESSION_LIFETIME_MS`、`DEMO_BUDGET_CURRENCY`、`DEMO_BUDGETS_JSON`、`DEMO_GRAPH_BUDGETS_JSON`、`DEMO_BUDGET_TIMEOUT_MS`、`DEMO_LEASE_TTL_MS`、`DEMO_CONCURRENCY_LIMIT`、`DEMO_RESEARCH_IP_DAILY_RUNS` |
| BFF | `BFF_ALLOWED_ORIGINS`、`BFF_UPSTREAM_TIMEOUT_MS`、`BFF_RATE_LIMIT_USER_MAX_REQUESTS`、`BFF_RATE_LIMIT_USER_WINDOW_MS`、`BFF_RATE_LIMIT_IP_MAX_REQUESTS`、`BFF_RATE_LIMIT_IP_WINDOW_MS` |
| PostgreSQL | `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`SPIKE_DATABASE_URL` |

`SPIKE_DATABASE_URL` 指向本 Compose 的 `knowledge-postgres` service，並與三個 `POSTGRES_*` 值一致。隔離資料庫供 knowledge 與既有業務持久化表使用，不作為開源 server 的 checkpoint store，也不沿用根目錄的既有資料庫連線。

本次另外產生 Git 忽略的 `.env.spike.local`。其中價格與額度是測試 fixture，session 與資料庫憑證是隨機測試值，不代表部署設定。重跑這份設定時，在各 Compose 命令加入第二個 `--env-file deploy/self-hosted-runtime/.env.spike.local`。不要把私有設定檔或展開後的 Compose 寫入 evidence。

## 拓樸與續作

runtime、BFF、Redis、pgvector PostgreSQL 使用專屬 network。帳本前綴固定為 `spike-mit-langgraph-server:run-001`。`runtime-data` 掛載至 `/app/backend/.langgraph_api`；Redis 與 PostgreSQL 另有具名 volume。只有 BFF 發布 loopback `127.0.0.1:8124`，其餘服務不發布 host port。Redis 使用 `redis:8-alpine`。

取得合法 CurrentState／Handoff 後，本機續作命令為：

```powershell
docker compose --env-file .env --env-file deploy/self-hosted-runtime/.env.spike.local --file deploy/self-hosted-runtime/compose.yaml up --detach ledger knowledge-postgres
docker compose --env-file .env --env-file deploy/self-hosted-runtime/.env.spike.local --file deploy/self-hosted-runtime/compose.yaml run --rm runtime npm run migrations:up
docker compose --env-file .env --env-file deploy/self-hosted-runtime/.env.spike.local --file deploy/self-hosted-runtime/compose.yaml up --detach runtime bff
```

本次已在隔離資料庫執行 26 個既有 migrations。任何 migration 或 ready 失敗都須保存遮蔽後的證據。缺金鑰時自建入口與既有 CLI 的同環境啟動／ready 結果相同，依新版 Scenario 通過並記為既有產品缺口。沒有額外加入金鑰檢查。

結束服務使用相同 Compose 的 `down`，保留具名 volume；重啟驗證不可刪除 volume。

## 映像掃描

```powershell
python -X utf8 deploy/self-hosted-runtime/test_scan_image.py
python -X utf8 deploy/self-hosted-runtime/scan_image.py chat-gun-runtime-spike:local
python -X utf8 deploy/self-hosted-runtime/scan_image.py chat-gun-runtime-spike-bff:local
```

掃描器逐層讀取 `docker image save` archive，不解壓到專案，退出時移除暫存檔。較早 layer 中已刪除的檔案仍會掃描；結果只含位置及規則，不含匹配值。錯誤或疑似 secret 均回傳非零。

`--known-secrets-stdin` 可透過 stdin 接收 JSON 字串陣列，加做已知值精確比對。清單不能放在命令列或 evidence。原掃描器仍回報 87／13 筆疑似命中；第二輪已逐筆重現並判讀為誤判，規則、層、路徑、offset、內容指紋與理由保存在 candidate-inspection-apply-002。沒有路徑白名單。GnuTLS 的完整 PEM 以官方公開 self-test 向量指紋比對，PEM 內文不輸出；來源只在記憶體解析，不執行或保存。

## 第二輪驗證腳本

| 命令（從根目錄執行） | 用途 |
| --- | --- |
| `node deploy/self-hosted-runtime/compare-runtimes.mjs` | 缺金鑰的同環境對照；依序重新建立 runtime／BFF |
| `node deploy/self-hosted-runtime/inspect-candidates.mjs` | 匯出兩映像，逐筆重現與判讀；需要網路讀取官方公開向量 |
| `node deploy/self-hosted-runtime/scan-settings.mjs` | 掃描 Git 未忽略的本目錄檔案 |
| `node deploy/self-hosted-runtime/positive-smoke.mjs` | ready 與真實模型 Gun Chat smoke |
| `node deploy/self-hosted-runtime/checkpoint-priority.mjs` | V0：兩個 graph 的真實 run、檔案與 SIGTERM |
| `node deploy/self-hosted-runtime/restart-approval.mjs` | V1：合成退款 interrupt、SIGTERM、resume 與重放 |
| `python -B -X utf8 -m unittest discover -s deploy/self-hosted-runtime -p 'test_*.py'` | 掃描器及 PEM 證據保密測試 |
| `node --test deploy/self-hosted-runtime/approval-verdict.test.mjs` | 不將 HTTP 200 no-op 誤判為拒絕 |

腳本將 evidence 寫入本 Change 的本機 Runtime Artifact，並在 mutation 前核對 Codex／IMPLEMENTING／handoff-apply-change-002。下一個 Handoff 必須依其核准契約調整 guard，不能繞過檢查。V1 的 `--continue` 僅供沿用本輪第一次因 interrupt type 辨識錯誤而未送出 resume 的案例，不用於已完成的審批。

V1 的實測與判定分別為 v1-apply-002、v1-verdict-apply-002；判定失敗的項目不勾選。沒有新增 V2～V5 腳本或假模型端點。第二輪容器已清理，volumes／映像保留。

## 第三輪驗證

`validation-003.mjs` 的 guard 限定 handoff-apply-change-003；002 工具與既有測試保持原狀。

- `node deploy/self-hosted-runtime/compare-approval-003.mjs`：沿用自建 V1，補 audit 與 CLI 全流程對照；需要真實模型與 Docker。CLI 使用獨立 Compose project／全新資料庫，但 Config.Env 與自建入口相同。
- `node deploy/self-hosted-runtime/kill-interrupt-003.mjs`：V2(a) 真實 interrupt 後 SIGKILL、讀回檔案與 API。最終判定還須包含 D-3 的遺失範圍，不只看三項硬性不變量。
- `node --test deploy/self-hosted-runtime/crash-verdict-003.test.mjs deploy/self-hosted-runtime/loss-window-003.test.mjs`：驗證不變量與遺失年齡計算。

本輪觀察到約三秒 debounce 可因存取重設；實測七個 checkpoint 遺失，最早資料年齡為 4,824 毫秒。V2 其餘時點與 V3～V5 未執行，沒有假模型端點。容器已清理、volumes 保留；細節以 findings 與 apply-003 evidence 為準。

## 第四輪驗證

使用 handoff-apply-change-004 的角色 guard；只有 owner 為 Codex 且處於實作階段時可執行。

- `node deploy/self-hosted-runtime/kill-stream-004.mjs`：V2(b) 初始 values 後確認 running 再 SIGKILL。
- `node deploy/self-hosted-runtime/kill-resume-004.mjs before`／`after`：審批 side-effect 前／後故障；before 使用隔離 DB 列鎖。
- `node deploy/self-hosted-runtime/stream-cancel-004.mjs`：V3，Redis MONITOR 只保存本 Change lease 指令。
- V4 以 CUA 實際操作 BFF `/app/`，結果存 v4-browser-apply-004。
- `node deploy/self-hosted-runtime/resource-week-004.mjs`：V5 本機假模型，280 輪、依序、每日重啟。初次 BFF 429 已保留；`--retry-rate` 僅接受該初始錯誤，以新隔離環境完整重跑並遵循 retryAfter。
- `--resume-sampler` 僅接受已保存完整日流量與採樣、但採樣器關閉逾時的狀態；補該日重啟驗證後接續下一天，不重送已完成輪次。
- `node deploy/self-hosted-runtime/update-findings-004.mjs` 與 `scan-settings-004.mjs`：整理已通過實測與掃描公開檔案；私有值只在記憶體與 Git 忽略環境檔。

V5 採樣直接讀 runtime PID 1 的 RSS 與持久化檔案 metadata，不碰 API，不重設 debounce。模型回應是合成 fixture，不能據以判斷模型語意；時間分布、限流等待與採樣限制都寫入 findings.md。各隔離 project 使用獨立 volumes，清理保留 volumes 與映像。
