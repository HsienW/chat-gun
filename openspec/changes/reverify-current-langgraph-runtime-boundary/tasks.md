# Tasks：reverify-current-langgraph-runtime-boundary

> 每個 Task 皆可獨立驗證；本 Change 不修改 application code，驗證命令以唯讀盤點與 live spike 為主。

## T1 現況盤點：Graph 編譯、checkpointer 使用與 Server-level persistence

- [ ] 逐一確認 `backend/src/agents/chatbot.ts`、`math-agent.ts`、`mcp-agent.ts`、`deep-researcher.ts` 的 `builder.compile(...)` 是否傳入 checkpointer。
- [ ] 確認 `deep-researcher.ts` 的 checkpointer 型別（in-memory `MemorySaver`）。
- [ ] 確認 `backend/langgraph.json` 的 Graph 註冊與 `http.configurable_headers`。
- [ ] 確認 `docker-compose.yml` 的 `langgraph-api`／`langgraph-postgres`／`langgraph-redis` 組合。
- [ ] 調查 LangGraph Platform（`langchain/langgraphjs-api:20` base image）在 `POSTGRES_URI` 存在時是否自動提供 server-level checkpointer，記錄其覆蓋範圍（此為責任歸屬表的基礎假設，MUST 先確認）。
- [ ] 引用既有 `backend/src/operations/__spike__/worker-queue-signal.live-spike.test.ts` 的發現作為 live spike 設計起點。

驗證命令：

```bash
grep -rn "builder.compile\|checkpointer\|MemorySaver" backend/src/agents --include="*.ts"
cat backend/langgraph.json
cat docker-compose.yml
cat Dockerfile
# 於 Postgres 確認 server-level checkpoint 表，驗證 LangGraph Platform 預設持久化行為
```

## T2 Agent Server 生命週期 live spike

- [ ] 啟動既有 `docker-compose.yml` 的 LangGraph Agent Server。
- [ ] 執行 create Run → stream → interrupt → restart → resume → cancel → terminal lookup 完整循環。
- [ ] 記錄每一步行為與可重播證據。

驗證命令：

```bash
docker compose up -d langgraph-postgres langgraph-redis langgraph-api
# 依實際 Agent Server API 建立 run 並觸發 interrupt/resume/cancel
```

## T3 持久化來源驗證：Graph-level 與 Server-managed persistence

- [ ] 對無 explicit checkpointer 的 Graph（`chatbot`／`math_agent`／`mcp_agent`）執行 run 並在 interrupt 後 resume。
- [ ] 記錄 checkpoint／resume 由誰提供、粒度如何、與 Graph-level checkpointer 的互動為何（非「可用 vs 不可用」）。
- [ ] 獨立驗證 Server-managed persistence，依序執行：
  1. 啟動 `langgraph-postgres`，連入 Postgres（`postgres://postgres:postgres@localhost:5433/postgres`）。
  2. 對無 checkpointer Graph 觸發 interrupt 後，查詢 `checkpoints`／`checkpoint_blobs`／`checkpoint_writes` 表，確認是否有 server-level 寫入。
  3. 對照 `deep_researcher`（MemorySaver）的 checkpoint 表內容差異。
  4. 記錄結論：server-level checkpointer 是否存在、覆蓋哪些 State、與 Graph-level checkpointer 的互動。

驗證命令：

```bash
docker compose up -d langgraph-postgres langgraph-redis langgraph-api
docker compose exec langgraph-postgres psql -U postgres -c '\dt' -c 'SELECT thread_id, checkpoint_id, parent_checkpoint_id FROM checkpoints ORDER BY checkpoint_id DESC LIMIT 5;'
```

## T4 `deep_researcher` MemorySaver 行為分類

- [ ] 對 `deep_researcher` 執行 interrupt 後 resume。
- [ ] 記錄 State 恢復正確性、副作用是否重複。
- [ ] 明確分類 `MemorySaver` 為 override／complement／conflict，並給出「保留／移除／隔離到測試」處置建議。

## T5 原生訊號到 Chat-Gun 概念映射

- [ ] 將 LangGraph native 的 Queue／Worker／Run／Thread／Checkpointer／Store 訊號映射到 Chat-Gun 的 Task／Step／ownership／operations 概念。
- [ ] 依下列準則判定每項能力的歸屬：
  - 原生已完整覆蓋且不需業務語義 → Authority 為 LangGraph native，Chat-Gun 僅做 observability。
  - 原生不管業務語義／副作用／審計／成本 → Chat-Gun 自建，並標明「補原生缺口」的正當性。
  - 原生提供訊號、Chat-Gun 提供決策 → 兩者協作，標明協作邊界。
- [ ] 產出責任歸屬表（Authority／Chat-Gun extension／Failure owner）。

## T6 權威來源定義

- [ ] 定義 Run status、Run ID、checkpoint identity、resume compatibility 的權威來源。
- [ ] 確認每個權威來源以穩定 machine identifier 為基礎，不以顯示文案或模型輸出推斷。

## T7 Failure Drills

- [ ] 逐項演練下列 6 個 drill，每個標明 replay-safe 或 side-effect ambiguity：
  1. first checkpoint 前 process 終止
  2. 等待 interrupt 期間 process 終止
  3. Tool dispatch 後、Tool result 持久化前 process 終止
  4. 以 compatible manifest 的部署重啟
  5. 以 incompatible manifest 的部署重啟
  6. resume 期間 PostgreSQL 或 Redis 不可用
- [ ] 每個 drill 記錄失敗歸屬（Agent Server／Backend／Tool adapter／Operations）。

## T8 產出 Decision Record

- [ ] 撰寫 `docs/decisions/current-langgraph-runtime-boundary.md`。
- [ ] 包含 LangGraph 版本、責任歸屬表、identity ownership 地圖、`MemorySaver` 分類、每項自建責任的正當性證據。
- [ ] 無法執行的 live 驗證如實標記「未驗證」。

驗證命令（本 Change 無程式碼 build，以文件完整性與 review 為驗證）：

```bash
test -f docs/decisions/current-langgraph-runtime-boundary.md
```
