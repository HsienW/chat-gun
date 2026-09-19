# Design：reverify-current-langgraph-runtime-boundary

## 定位

本 Change 為研究型／spike 型，**不修改 frontend、bff、backend 的任何程式碼、契約、Schema 或 infra 設定**。設計重點是「如何取得可追溯的驗證證據」以及「如何把證據收斂成一份可仲裁的責任邊界」。

- `frontend`：無變更。
- `bff`：無變更。
- `backend`：無程式碼變更；僅作為驗證主體（Graph 編譯、checkpointer、`langgraph dev` 生命週期）。

## 驗收標準（2026-09-19 修訂）

動態實證以 **`langgraph dev`** 為正式驗收標準：

- 啟動方式：`backend` 內執行 `npm run dev -- --no-browser`（`langgraphjs dev`，`@langchain/langgraph-cli` 1.4.5），API 位於 `http://localhost:2024`，in-memory development server。
- Graph 註冊：`backend/langgraph.json` 的 `env` 指向 `backend/.env`；四個 Graph 均註冊成功。

原 Docker Agent Server（`langgraphjs-api:20`）＋ PostgreSQL／Redis 建置與 LangSmith 授權路徑已**移出本次驗收範圍**：

- 原版 `Dockerfile` 的 `npm install --omit=dev` 因 `patch-package` 位於 devDependencies 而 exit 127，本 Change 不修改 infra 設定。
- LangSmith 授權端點回 403、容器 exit 3，Run 層級證據無法取得。
- 因此「server-managed PostgreSQL／Redis persistence」「worker lease」「強制 process kill durability」等正式部署維度，在 Decision Record 中一律標記「未驗證（超出 langgraph dev 範圍）」，另立後續 Change 驗證。

## 責任邊界判定方法

判定責任歸屬的核心原則是：**以實際執行（live spike）為準，不以文件或既有結論推斷**。每個能力維度都經過「靜態盤點 → 動態實證 → 歸屬判定」三步。

```text
靜態盤點（原始碼分析）
  → 動態實證（langgraph dev live spike）
  → 責任歸屬判定（LangGraph native / Chat-Gun extension / 協作 / 未驗證）
  → Failure owner 標記
  → Decision Record
```

## 靜態盤點範圍

1. **Graph 編譯與 checkpointer**：逐一確認 `chatbot`、`math_agent`、`mcp_agent`、`deep_researcher` 的 `builder.compile(...)` 是否傳入 `checkpointer`。
2. **Agent Server 註冊**：`backend/langgraph.json` 的 `graphs`、`http.configurable_headers`、`env`。
3. **Infra 組合（僅靜態事實）**：`docker-compose.yml` 的 `langgraph-api`、`langgraph-postgres`、`langgraph-redis` 組合，作為「正式部署應如何」的對照，但不作為動態實證目標。
4. **既有自建原語清單**：列出 Chat-Gun 已存在的 Task/Step、Retry、Idempotency/Audit、Compensation、Distributed Step Lock、Side-effect Ledger、Interaction Runtime、Context Budget、Long-term Memory Governance、Operations 模組，作為責任歸屬表的對照。

## 動態實證（live spike）設計

以 `langgraph dev` 開發伺服器執行以下生命週期，並記錄可重播證據：

```text
create Run
  → stream
  → interrupt（interrupt_before／interrupt_after，等待 HITL）
  → 正常停止後 restart
  → resume
  → cancel
  → terminal lookup
```

關鍵對照組：

| 對照組 | Graph | Checkpointer | 觀察重點 |
|---|---|---|---|
| A | `chatbot` / `math_agent` / `mcp_agent` | 無 explicit checkpointer | dev 模式下 checkpoint／resume 由誰提供、粒度與可用性、跨正常重啟是否保留 State |
| B | `deep_researcher` | in-memory `MemorySaver` | interrupt 後 resume 的 State 恢復、副作用是否重複、MemorySaver 在 dev 模式下的行為 |
| C（移出範圍） | 正式 Agent Server + PostgreSQL／Redis | Server-managed persistence | **未驗證**：server-level checkpointer 是否存在、覆蓋哪些 State、與 Graph-level checkpointer 的互動——另立後續 Change |

## 責任歸屬表（Decision Record 骨架，已依 langgraph dev 標準收斂）

| Capability | Authority | Chat-Gun extension／補原生缺口的依據 | Failure owner |
|---|---|---|---|
| Run queue／worker assignment | LangGraph native（V：dev 公開 Run／Thread API 無 claim／lease／heartbeat；Docker worker lease 未驗證） | Observability only；不自建 queue | Agent Server（Docker worker lease 維度未驗證） |
| Graph checkpoint／interrupt | LangGraph native（V：`chatbot`／`deep_researcher` 可 interrupt、跨正常重啟恢復、resume） | `manifest.ts` 的版本相容性與業務關聯；不複製 checkpoint | Backend／Agent Server，依失敗邊界區分 |
| 業務 Task／Step 狀態 | Chat-Gun（S） | `types.ts`、`state-machine.ts`、`task-repository.ts` | Backend |
| 可見 Run generation | Chat-Gun interaction runtime（S） | `ownership.ts` 的 scope／generation CAS | Backend |
| Side-effect commit truth | Tool adapter + Chat-Gun ledger（S；V 未以真實副作用驗證） | `business-effect-ledger.ts` 分開 prepared／committed／unknown | Tool adapter；Operations 執行 reconciliation |
| 長期記憶 | LangGraph Store 機制（D）＋ Chat-Gun governance（S） | `memory-governance-service.ts` 處理授權、scope、history、provenance | Backend／Store adapter |
| Worker recovery 決策 | Server native 訊號（D）＋ Chat-Gun 分類（S） | `worker-recovery.ts`、`reaper.ts` 依 replay safety 決定 requeue／park／reconcile | Operations；Server 本身故障歸 Agent Server |
| Server-managed PostgreSQL／Redis persistence | **未驗證（超出 langgraph dev 驗收範圍，另立後續 Change）** | — | — |

## 資料流與證據保存

1. live spike 的每一步輸出（create/stream/interrupt/restart/resume/cancel/terminal）作為證據保存於 Decision Record 附錄或可引用位置。
2. `MemorySaver` 的行為描述與處置建議單獨成節；其 override／complement／conflict 分類標記「未驗證」。
3. 每個結論標註其來源（原始碼引用 S、`langgraph dev` 實測 V、官方文件 D、或「未驗證」）。

## 替代方案與取捨

| 方案 | 說明 | 取捨 |
|---|---|---|
| 只做靜態盤點（不跑 live spike） | 成本低 | 違反「以實際執行為準」原則，無法證明中斷／恢復／串流行為，不採用 |
| 直接沿用 X0 舊結論 | 最快 | X0 的 Decision Record 已不存在且程式碼已演進，證據失效，不採用 |
| 等待 Docker/LangSmith 授權修復後再驗證 | 涵蓋正式部署 | 授權與 Dockerfile 修復超出本 Change 範圍，且會阻塞 X12 前置；改採 `langgraph dev` 先行收斂可證明的邊界 |
| 靜態盤點 + `langgraph dev` live spike + Decision Record | 本方案 | 成本適中；以 dev 模式證明 native interrupt／resume／stream 語意，正式部署持久化另立 Change |

## 風險與緩解

- live spike 無法執行（`langgraph dev` 啟動失敗）：對應能力標記「未驗證」，不宣稱通過。
- dev 模式與正式 Agent Server 行為漂移：Decision Record 明確區分 V 與 D 證據，不把 dev 結論升格為正式部署結論。
- 自建模組與 native 邊界模糊：以「補原生缺口」的證據要求，避免重造輪子。

## 對後續 X12–X21 的影響

Decision Record 是 X12（Canonical ExecutionContext）、X13（Authorization/HITL）、X14（Tool Dispatch）、X17（Input Guard）、X19（Event Envelope）、X20（Durable Recovery）、X21（Readiness Gate）的架構前置。未通過 review 前，MUST NOT 開始 X12 的 application code 整合。Server-managed persistence 維度在另立 Change 完成前，X12 起涉及正式部署持久化的決策必須標記為「基於未驗證假設」。
