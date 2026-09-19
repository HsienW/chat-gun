# Tasks：reverify-current-langgraph-runtime-boundary

> 每個 Task 皆可獨立驗證；本 Change 不修改 application code，驗證命令以唯讀盤點與 `langgraph dev` live spike 為主。
>
> 驗收標準（2026-09-19 修訂）：動態實證以 `langgraph dev`（in-memory development server）為正式標準。原 Docker Agent Server＋PostgreSQL／Redis 與 LangSmith 授權路徑已移出本次範圍，其維度一律標記「未驗證」。

## T1 現況盤點：Graph 編譯、checkpointer 使用與 infra 靜態事實

- [x] 逐一確認 `backend/src/agents/chatbot.ts`、`math-agent.ts`、`mcp-agent.ts`、`deep-researcher.ts` 的 `builder.compile(...)` 是否傳入 checkpointer。
- [x] 確認 `deep-researcher.ts` 的 checkpointer 型別（in-memory `MemorySaver`）。
- [x] 確認 `backend/langgraph.json` 的 Graph 註冊與 `http.configurable_headers`。
- [x] 確認 `docker-compose.yml` 的 `langgraph-api`／`langgraph-postgres`／`langgraph-redis` 組合（僅作為靜態事實，不作為動態實證目標）。
- [x] 引用既有 `backend/src/operations/__spike__/worker-queue-signal.live-spike.test.ts` 的發現作為 live spike 設計起點。
- 移出範圍：LangGraph Platform（`langchain/langgraphjs-api:20`）在 `POSTGRES_URI` 存在時是否自動提供 server-level checkpointer——此維度不再於本 Change 驗證，於 Decision Record 標記「未驗證」，另立後續 Change。

驗證命令：

```bash
grep -rn "builder.compile\|checkpointer\|MemorySaver" backend/src/agents --include="*.ts"
cat backend/langgraph.json
cat docker-compose.yml
```

## T2 `langgraph dev` 生命週期 live spike

- [ ] 以 `backend` 內 `npm run dev -- --no-browser`（`langgraphjs dev`，`http://localhost:2024`）啟動開發伺服器，確認四個 Graph 註冊成功。
- [ ] 執行 create Run → stream → interrupt → restart → resume → cancel → terminal lookup 完整循環。
- [ ] 記錄每一步行為與可重播證據（可重複使用既有 `dev-thread-spike.mjs` 與 `dev-thread-spike.json`／`dev-stream-spike.json`／`dev-deep-thread-spike.json`，並補上 cancel 證據）。

驗證命令：

```bash
cd backend
npm run dev -- --no-browser
# 依 dev server API 建立 run 並觸發 interrupt/restart/resume/cancel/terminal lookup
```

## T3 持久化來源驗證：無 checkpointer 與 MemorySaver 兩類 Graph

- [ ] 對無 explicit checkpointer 的 Graph（`chatbot`／`math_agent`／`mcp_agent`）執行 run 並在 interrupt 後 resume。
- [ ] 記錄 checkpoint／resume 由誰提供、粒度如何、跨正常重啟是否保留 State。
- [ ] 對 `deep_researcher`（`MemorySaver`）執行 interrupt 後 resume，記錄 checkpoint 覆蓋的 State 欄位與恢復正確性。
- [ ] 記錄兩類 Graph 的 checkpoint identity（`checkpoint_id`／`checkpoint_ns`）在 restart 前後與 resume 後的變化。
- 移出範圍：直接查詢 Postgres 的 `checkpoints`／`checkpoint_blobs`／`checkpoint_writes` 表以驗證 server-level 寫入——不於本 Change 執行，標記「未驗證」。

驗證命令：

```bash
cd backend
npm run dev -- --no-browser
# 以既有 dev-thread-spike 腳本對 Graph A 與 Graph B 執行 prepare/restart/resume，記錄 checkpoint 欄位
```

## T4 `deep_researcher` MemorySaver 行為分類

- [ ] 對 `deep_researcher` 執行 interrupt 後 resume。
- [ ] 記錄 State 恢復正確性、副作用是否重複（現有 V 證據走 `validate_uploads` 錯誤分支，未呼叫模型或 Tool）。
- [ ] 描述 `MemorySaver` 在 `langgraph dev` 下的行為，並給出「保留／移除／隔離到測試」處置建議；其相對於 server-managed persistence 的 override／complement／conflict 分類標記「未驗證」。

## T5 原生訊號到 Chat-Gun 概念映射

- [ ] 將 LangGraph native 的 Queue／Worker／Run／Thread／Checkpointer／Store 訊號映射到 Chat-Gun 的 Task／Step／ownership／operations 概念。
- [ ] 依下列準則判定每項能力的歸屬：
  - 原生已完整覆蓋且不需業務語義 → Authority 為 LangGraph native，Chat-Gun 僅做 observability。
  - 原生不管業務語義／副作用／審計／成本 → Chat-Gun 自建，並標明「補原生缺口」的正當性。
  - 原生提供訊號、Chat-Gun 提供決策 → 兩者協作，標明協作邊界。
- [ ] 產出責任歸屬表（Authority／Chat-Gun extension／Failure owner），無法以 `langgraph dev` 證據支撐者標記「未驗證」。

## T6 權威來源定義

- [ ] 定義 Run status、Run ID、checkpoint identity、resume compatibility 的權威來源。
- [ ] 確認每個權威來源以穩定 machine identifier 為基礎，不以顯示文案或模型輸出推斷。

## T7 Failure Drills

- [ ] 逐項演練下列 6 個 drill，每個標明 replay-safe 或 side-effect ambiguity，並標明實證等級（V 實測／S 靜態推理／未驗證）：
  1. first checkpoint 前 process 終止
  2. 等待 interrupt 期間 process 終止（V 涵蓋「正常停止後重啟」；強制 kill 標記「未驗證」）
  3. Tool dispatch 後、Tool result 持久化前 process 終止（未以真實副作用實證，標記 side-effect ambiguity）
  4. 以 compatible manifest 的部署重啟（S＋`manifest.test.ts`）
  5. 以 incompatible manifest 的部署重啟（S＋`manifest.test.ts`）
  6. resume 期間 PostgreSQL 或 Redis 不可用（超出 langgraph dev 範圍，標記「未驗證」）
- [ ] 每個 drill 記錄失敗歸屬（Agent Server／Backend／Tool adapter／Operations）。

## T8 產出 Decision Record

- [ ] 依修訂後標準重新收斂 `docs/decisions/current-langgraph-runtime-boundary.md`。
- [ ] 包含 LangGraph 版本、啟動方式（`langgraph dev`）、責任歸屬表、identity ownership 地圖、`MemorySaver` 分類、每項自建責任的正當性證據。
- [ ] 明確列出「未驗證（超出 langgraph dev 驗收範圍）」清單（server-managed persistence、worker lease、強制 kill durability）。
- [ ] 無法執行的 live 驗證如實標記「未驗證」。

驗證命令（本 Change 無程式碼 build，以文件完整性與 review 為驗證）：

```bash
test -f docs/decisions/current-langgraph-runtime-boundary.md
git diff --check
```
