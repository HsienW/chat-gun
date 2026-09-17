# Design：reverify-current-langgraph-runtime-boundary

## 定位

本 Change 為研究型／spike 型，**不修改 frontend、bff、backend 的任何程式碼、契約、Schema 或 infra 設定**。設計重點是「如何取得可追溯的驗證證據」以及「如何把證據收斂成一份可仲裁的責任邊界」。

- `frontend`：無變更。
- `bff`：無變更。
- `backend`：無程式碼變更；僅作為驗證主體（Graph 編譯、checkpointer、Agent Server 生命週期）。

## 責任邊界判定方法

判定責任歸屬的核心原則是：**以實際執行（live spike）為準，不以文件或既有結論推斷**。每個能力維度都經過「靜態盤點 → 動態實證 → 歸屬判定」三步。

```text
靜態盤點（原始碼分析）
  → 動態實證（Agent Server live spike）
  → 責任歸屬判定（LangGraph native / Chat-Gun extension / 協作）
  → Failure owner 標記
  → Decision Record
```

## 靜態盤點範圍

1. **Graph 編譯與 checkpointer**：逐一確認 `chatbot`、`math_agent`、`mcp_agent`、`deep_researcher` 的 `builder.compile(...)` 是否傳入 `checkpointer`。
2. **Agent Server 註冊**：`backend/langgraph.json` 的 `graphs`、`http.configurable_headers`、`env`。
3. **Infra 組合與 Server-level persistence**：`docker-compose.yml` 的 `langgraph-api`、`langgraph-postgres`、`langgraph-redis`；並調查 LangGraph Platform（`langchain/langgraphjs-api:20` base image）在 `POSTGRES_URI` 存在時是否自動提供 server-level checkpointer——此為責任歸屬表的基礎假設，MUST 先確認。
4. **既有自建原語清單**：列出 Chat-Gun 已存在的 Task/Step、Retry、Idempotency/Audit、Compensation、Distributed Step Lock、Side-effect Ledger、Interaction Runtime、Context Budget、Long-term Memory Governance、Operations 模組，作為責任歸屬表的對照。

## 動態實證（live spike）設計

對真實 Agent Server 部署執行以下生命週期，並記錄可重播證據：

```text
create Run
  → stream
  → interrupt（等待 HITL）
  → restart
  → resume
  → cancel
  → terminal lookup
```

關鍵對照組：

| 對照組 | Graph | Checkpointer | 觀察重點 |
|---|---|---|---|
| A | `chatbot` / `math_agent` / `mcp_agent` | 無 explicit | checkpoint／resume 由誰提供（可能為 Server-managed persistence）、粒度與可用性 |
| B | `deep_researcher` | in-memory `MemorySaver` | interrupt 後 resume 的 State 恢復、副作用是否重複、MemorySaver 與 Server 持久化的關係 |
| C | 無（直接查 Postgres checkpoint 表） | Server-managed persistence | LangGraph Platform 依 `POSTGRES_URI` 提供的 server-level checkpointer 是否存在、覆蓋哪些 State、與 Graph-level checkpointer 的互動 |

## 責任歸屬表（Decision Record 骨架）

| Capability | Authority | Chat-Gun extension | Failure owner |
|---|---|---|---|
| Run queue 與 worker assignment | LangGraph native 或 verified alternative | Observability only | Agent Server |
| Graph checkpoint 與 interrupt | LangGraph native | Compatibility manifest 與 business correlation | Backend |
| 業務 Task/Step 狀態 | Chat-Gun | Task repositories 與 events | Backend |
| 可見 Run generation | Chat-Gun interaction runtime | CAS ownership | Backend |
| Side-effect commit truth | ToolExecution ledger + downstream reconciliation | Business effect identity | Tool adapter |
| 長期記憶 | LangGraph Store boundary + Chat-Gun governance | Scope、history、provenance | Backend |
| Worker recovery 決策 | Native signals + Chat-Gun classification | Requeue-safe/park/reconcile policy | Operations |

## 資料流與證據保存

1. live spike 的每一步輸出（create/stream/interrupt/resume/cancel/terminal）作為證據保存於 Decision Record 附錄或可引用位置。
2. `MemorySaver` 的行為分類與處置建議單獨成節。
3. 每個結論標註其來源（原始碼引用、live spike 輸出、或「未驗證」）。

## 替代方案與取捨

| 方案 | 說明 | 取捨 |
|---|---|---|
| 只做靜態盤點（不跑 live spike） | 成本低 | 違反「以實際執行為準」原則，無法證明持久化行為，不採用 |
| 直接沿用 X0 舊結論 | 最快 | X0 的 Decision Record 已不存在且程式碼已演進，證據失效，不採用 |
| 靜態盤點 + live spike + Decision Record | 本方案 | 成本較高，但提供可仲裁、可追溯的事實來源，作為 X12–X21 的唯一前置 |

## 風險與緩解

- live spike 無法執行（infra/認證）：對應能力標記「未驗證」，不宣稱通過。
- LangGraph 版本行為漂移：Decision Record 標註版本與部署資訊。
- 自建模組與 native 邊界模糊：以「補原生缺口」的證據要求，避免重造輪子。

## 對後續 X12–X21 的影響

Decision Record 是 X12（Canonical ExecutionContext）、X13（Authorization/HITL）、X14（Tool Dispatch）、X17（Input Guard）、X19（Event Envelope）、X20（Durable Recovery）、X21（Readiness Gate）的架構前置。未通過 review 前，MUST NOT 開始 X12 的 application code 整合。
