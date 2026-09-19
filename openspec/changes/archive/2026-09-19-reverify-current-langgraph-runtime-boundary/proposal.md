# Proposal：reverify-current-langgraph-runtime-boundary

## 變更摘要

以「現在存在」的程式碼與部署，重新驗證 LangGraph 原生 Runtime 與 Chat-Gun 自建 Runtime 模組之間的責任邊界，產出一份可追溯的 Decision Record（`docs/decisions/current-langgraph-runtime-boundary.md`），證明哪些生命週期責任歸 LangGraph native，哪些歸 Chat-Gun 的 Task／ToolExecution／Interaction／Operations 模組，並作為 X12 之後所有 Runtime 整合工作的唯一前置事實來源。

本 Change 對應 `second-stage-plan-en-v4.md` 的 **X11**，是 Layer 4（Runtime Integration Foundation）的第一個、也是唯一的決策型／spike 型 Change，**不修改任何 application code**。

> 驗收標準（2026-09-19 修訂）：動態實證改以 **`langgraph dev`（`backend` 的 `langgraphjs dev --no-browser`，`http://localhost:2024`，in-memory development server）** 為正式驗收標準。原以 Docker Agent Server（`langgraphjs-api:20`）＋ PostgreSQL／Redis 建置與 LangSmith 授權為驗收路徑，因原版 Dockerfile 建置失敗與 LangSmith 授權 403 而無法取得 Run 層級證據；Server-managed PostgreSQL／Redis 持久化維度**移出本次驗收範圍**，改為另立後續 Change 處理，於 Decision Record 中如實標記「未驗證」。

## 問題描述

X0（`verify-langgraph-server-runtime-boundary`，已 archive）曾在 LangGraph 邊界建立責任地圖，但：

1. X0 的 Decision Record（`docs/decisions/langgraph-runtime-boundary.md`）目前已不存在於 `docs/decisions/`，只剩 archive 內的 spec，無法作為後續整合的可引用事實來源。
2. 自 X0 之後，程式碼已大幅演進。目前（本 Change 建立時）的實際狀態：
   - `chatbot`、`math_agent`、`mcp_agent` 三個 Graph 皆以 `builder.compile()` 編譯，**沒有**任何 explicit checkpointer。
   - `deep_researcher` 以 `builder.compile({ checkpointer: new MemorySaver() })` 編譯，使用 **in-memory** MemorySaver。
   - `docker-compose.yml` 同時宣告 `langgraph-api`（LangGraph Agent Server）、`langgraph-postgres`（PostgreSQL 16）與 `langgraph-redis`（Redis 6）——此為靜態盤點事實；其 Server 層的實際持久化行為因授權問題未能實證，已移出本次驗收範圍。
3. Chat-Gun 現已累積大量自建 Runtime 原語：Task/Step State Machine、Retry Budget、Idempotency/Audit、Compensation、Distributed Step Lock、Side-effect Ledger、Interaction Runtime、Context Budget、Long-term Memory Governance、Operations（SLO/Recovery/Drain/Manifest/Canary/Release Gate）。

若在未重新驗證的情況下直接整合，風險是：自建模組可能在不知情下重複實作 LangGraph native 已內建的 Queue／Worker／Checkpointer／Store 能力，或反過來假設 native 會處理它其實不管的邊界（例如副作用冪等、業務 Task/Step 語意、審計、成本），造成 Runtime 缺陷或責任漂移。

## 解決方案

執行一個研究型／spike 型 OpenSpec Change，輸出單一 Decision Record。工作分為兩大類：

1. **現況盤點（靜態）**：逐一確認四個 Graph 的編譯方式與 checkpointer 使用、`langgraph.json` 的 Graph 註冊與 configurable headers、`docker-compose.yml` 的 infra 組合（僅作為靜態事實，不作為動態實證目標）。
2. **LangGraph native 生命週期實證（動態 live spike）**：以 `langgraph dev` 開發伺服器執行 create Run → stream → interrupt → restart → resume → cancel → terminal lookup 的完整循環，並對照無 explicit checkpointer 的 Graph（`chatbot`／`math_agent`／`mcp_agent`）與有 explicit `MemorySaver` 的 Graph（`deep_researcher`）兩類來源的實際行為差異。

最終把靜態與動態證據收斂為一份責任歸屬表，明確回答：

- 每個生命週期能力（Run queue/worker、Graph checkpoint/interrupt、業務 Task/Step 狀態、可見 Run generation、副作用 commit truth、長期記憶、worker recovery 決策）的**權威來源**（LangGraph native 或 Chat-Gun 自建）。
- `deep_researcher` 的 `MemorySaver` 在 `langgraph dev` 下的行為，及其相對於「正式 Agent Server server-managed persistence」的關係標記（未驗證／超出本次範圍）。
- 失敗歸屬（failure owner）落在 Agent Server、Backend、Tool adapter 或 Operations。

## 受影響範圍

### 受影響套件

- `backend`：LangGraph Runtime 驗證主體（Graph 編譯、checkpointer、`langgraph dev` 生命週期）。

### 不受影響套件（本 Change 不修改任何程式碼）

- `frontend`：無變更。
- `bff`：無變更。

### 受影響能力域

- LangGraph Runtime 能力邊界理解。
- 後續 X12（Canonical ExecutionContext）、X13（Authorization/HITL）、X14（Tool Dispatch）、X17（Input Guard）、X19（Event Envelope）、X20（Durable Recovery）、X21（Readiness Gate）的架構決策基礎。

### 既有能力原語（本 Change 只盤點、不修改）

- Task/Step State Machine、Retry Budget、Idempotency/Audit、Compensation、Distributed Step Lock、Side-effect Ledger、Interaction Runtime、Context Budget、Long-term Memory Governance、Operations（SLO/Recovery/Drain/Manifest/Canary/Release Gate）。

## 目標

- 以 `langgraph dev` 生命週期證明 interrupt/resume/stream 行為與 Graph-level checkpoint 邊界。
- 描述 `MemorySaver` 在 `langgraph dev` 下的行為，並給出「保留、後續移除、或隔離到測試」的處置建議；其與正式 Server-managed persistence 的 override/complement/conflict 分類標記為「未驗證」。
- 每一項自建 Runtime 責任都被證明是「補原生缺口」而非「重造輪子」。
- 產出 Run／Task／Step／ToolExecution／Checkpoint identity 的 ownership 地圖。
- Failure drills 區分 replay-safe work 與 side-effect ambiguity。
- 產出 Decision Record，供 X12 開始前 review。

## 非目標

- ❌ 不建立任何自訂 Queue 或 Worker Pool。
- ❌ 不建立第二套通用 Run 資料庫。
- ❌ 不在 Decision Record 核准前進行任何全程式範圍的 persistence migration。
- ❌ 不修改任何 Agent Graph（`chatbot`、`deep_researcher`、`math_agent`、`mcp_agent`）。
- ❌ 不變更 LangGraph 依賴版本。
- ❌ 不引入新的 application code 或跨層契約變更（本 Change 產出為文件）。
- ❌ 不驗證正式 Agent Server（`langgraphjs-api:20`）的 server-managed PostgreSQL／Redis 持久化、worker lease、強制 process kill durability 與 LangSmith 授權（超出本次範圍，另立後續 Change）。

## 風險

| 風險 | 緩解 |
|---|---|
| LangGraph 文件與實際行為不一致 | 以實際執行（live spike）驗證為準，不以文件推斷 |
| `langgraph dev` 是 in-memory development server，其行為不能直接推論到正式 Agent Server | Decision Record 明確區分 V（dev）證據與 D（文件）證據，任何正式部署結論標記「未驗證」 |
| `MemorySaver` 為 in-memory、跨 process 無法持久 | 描述其在 dev 模式的行為，override/complement/conflict 分類標記「未驗證」，並給出隔離或移除建議 |
| 原生能力隨 LangGraph 版本更新而變化 | Decision Record 標註驗證時的 LangGraph 版本與啟動方式 |
| live spike 需在 `backend` 以 `langgraph dev` 啟動 | 啟動失敗時對應能力標記「未驗證」，不宣稱通過 |

## 回滾策略

本 Change 僅產出文件（Decision Record），不修改程式碼、不變更 infra 或契約，無需回滾。若 Decision Record 未通過 review，可退回 PLAN_DRAFT 重新驗證並更新文件，不影響既有系統。
