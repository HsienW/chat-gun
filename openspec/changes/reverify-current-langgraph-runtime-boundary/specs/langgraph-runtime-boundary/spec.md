# Spec：Reverify Current LangGraph Runtime Boundary

## ADDED Requirements

### Requirement: 現況盤點（Graph 編譯與 Checkpointer 使用）

Coordinator SHALL 以原始碼分析盤點目前所有 Graph 的編譯方式與 checkpointer 使用，作為 Decision Record 的靜態證據。

#### Scenario: 四個 Graph 的編譯差異確認

GIVEN `backend/src/agents/` 下的 `chatbot`、`math_agent`、`mcp_agent`、`deep_researcher` 四個 Graph
WHEN 分析其 `builder.compile(...)` 呼叫
THEN Decision Record SHALL 明確記錄：
- 哪些 Graph 以「無 explicit checkpointer」方式編譯
- 哪個 Graph 以 explicit checkpointer 編譯，且其 checkpointer 型別（in-memory `MemorySaver` 或其他）
AND 記錄 `langgraph.json` 的 Graph 註冊、configurable headers 與 `docker-compose.yml` 的 infra 組合（PG／Redis／langgraph-api）

#### Scenario: 既有自建原語的盤點

GIVEN Chat-Gun 已存在的自建 Runtime 模組（Task/Step、Retry Budget、Idempotency/Audit、Compensation、Distributed Step Lock、Side-effect Ledger、Interaction Runtime、Context Budget、Long-term Memory Governance、Operations）
WHEN 建立 Decision Record
THEN 每個自建模組 SHALL 被標記其聲稱的責任範圍
AND 在責任歸屬表中與 LangGraph native 能力對應，以暴露潛在的重複或缺口

---

### Requirement: Agent Server 生命週期實證

Coordinator SHALL 對真實 LangGraph Agent Server 部署執行完整生命週期，證明 create Run → stream → interrupt → restart → resume → cancel → terminal lookup 的行為與持久化邊界。

#### Scenario: 完整生命週期循環

GIVEN 一個運作中的 LangGraph Agent Server（經由既有 `docker-compose.yml`）
WHEN 執行 create Run、stream、interrupt、restart、resume、cancel 與 terminal lookup
THEN 每一步的行為 SHALL 被記錄為可重播的證據
AND Decision Record SHALL 標明每一步是由 Server native、Chat-Gun 模組，還是兩者協作完成

#### Scenario: 無法執行 live spike 時的誠實記錄

GIVEN live spike 因 infra、認證或環境限制無法執行
WHEN 建立 Decision Record
THEN 對應能力 SHALL 標記為「未驗證」，MUST NOT 宣稱已通過

---

### Requirement: Checkpointer 持久化邊界驗證

Coordinator SHALL 驗證 Graph 在 Agent Server 上的實際持久化行為，明確區分三種來源：Graph-level explicit checkpointer、Server-managed persistence（LangGraph Platform 依 `POSTGRES_URI` 提供的 server-level checkpointer）、以及無任何持久化。

#### Scenario: 無 explicit checkpointer Graph 的持久化行為

GIVEN 一個以 `builder.compile()` 編譯、無 explicit checkpointer 的 Graph
WHEN 在 Agent Server 上執行一次 run（含 interrupt 或 process 中斷）
THEN Decision Record SHALL 記錄其 checkpoint／resume 由誰提供（可能為 Server-managed persistence）、粒度如何、與 Graph-level checkpointer 的互動為何
AND SHALL 記錄 State 是否跨 run 保留

#### Scenario: Server-managed persistence 的獨立驗證

GIVEN `docker-compose.yml` 提供 `POSTGRES_URI` 給 `langgraph-api`
WHEN 直接查詢 Postgres 的 checkpoint 表並執行 interrupt／resume
THEN Decision Record SHALL 記錄 server-level checkpointer 是否存在、覆蓋哪些 State、與 Graph-level checkpointer 的互動

#### Scenario: 有 Graph-level checkpointer Graph 的持久化行為

GIVEN 一個以 explicit checkpointer 編譯的 Graph（例如 `deep_researcher` 的 `MemorySaver`）
WHEN 在 Agent Server 上執行 interrupt 後 resume
THEN Decision Record SHALL 記錄 checkpoint 覆蓋哪些 State 欄位、resume 後是否正確恢復、副作用是否重複

#### Scenario: MemorySaver 與 Server-managed persistence 的關係

GIVEN `deep_researcher` 使用 in-memory `MemorySaver`
WHEN 分析其與 Agent Server 的持久化機制
THEN Decision Record SHALL 明確分類 MemorySaver 是 override、complement 或 conflict
AND 給出「保留、後續移除、或隔離到測試」的處置建議

---

### Requirement: 原生訊號到 Chat-Gun 概念的映射

Coordinator SHALL 將 LangGraph native 的 Queue／Worker／Run／Thread／Checkpointer／Store 訊號，映射到 Chat-Gun 的 Task／Step／ownership／operations 概念。

#### Scenario: 責任歸屬表產出

GIVEN 靜態盤點與動態實證的完整結果
WHEN 撰寫 Decision Record
THEN 責任歸屬表 SHALL 至少涵蓋以下能力維度：
- Run queue 與 worker assignment
- Graph checkpoint 與 interrupt
- 業務 Task/Step 狀態
- 可見 Run generation（active visible Run）
- Side-effect commit truth
- 長期記憶
- Worker recovery 決策
AND 每一維度 SHALL 標明 Authority（LangGraph native 或 verified alternative）、Chat-Gun extension 與 Failure owner

---

### Requirement: 權威來源定義

Coordinator SHALL 定義 Run status、Run ID、checkpoint identity 與 resume compatibility 的權威來源，不得以自然語言輸出或顯示字串推斷狀態。

#### Scenario: 權威來源聲明

GIVEN 責任歸屬表完成
WHEN 撰寫 Decision Record
THEN SHALL 明確指定：
- Run status 的權威來源
- Run ID 的權威來源
- checkpoint identity 的權威來源
- resume compatibility 的判斷依據
AND 每個權威來源 SHALL 以穩定機器可讀識別（machine identifier）為基礎，不以顯示文案或模型輸出推斷

---

### Requirement: Failure Drills

Coordinator SHALL 區分 replay-safe work 與 side-effect ambiguity，並記錄關鍵失敗情境的歸屬與處理。

#### Scenario: 關鍵失敗情境涵蓋

GIVEN 需驗證的失敗情境
WHEN 建立 Decision Record
THEN SHALL 涵蓋並分類以下 drills：
- first checkpoint 前 process 終止
- 等待 interrupt 期間 process 終止
- Tool dispatch 後、Tool result 持久化前 process 終止
- 以 compatible manifest 的部署重啟
- 以 incompatible manifest 的部署重啟
- resume 期間 PostgreSQL 或 Redis 不可用
AND 每個 drill SHALL 標明是 replay-safe 還是存在 side-effect ambiguity

---

### Requirement: Decision Record 產出

Coordinator SHALL 將所有驗證結果整理為單一 Decision Record（`docs/decisions/current-langgraph-runtime-boundary.md`）。

#### Scenario: Decision Record 完整性

GIVEN 所有盤點、實證、映射與 failure drills 結果
WHEN 撰寫 Decision Record
THEN 文件 SHALL 包含：
- 驗證時的 LangGraph 版本與部署資訊
- 責任歸屬表（Authority／Chat-Gun extension／Failure owner）
- Run／Task／Step／ToolExecution／checkpoint identity 的 ownership 地圖
- `MemorySaver` 的明確分類與處置建議
- 每項自建責任「補原生缺口」的正當性證據或原始碼引用
AND 每個結論 SHALL 有驗證證據或原始碼引用

#### Scenario: X12 前 review gate

GIVEN Decision Record 完成
WHEN 進入 X12 前
THEN Decision Record SHALL 通過獨立架構審查（review-plan）
AND 未通過審查時 MUST NOT 開始 X12 的 application code 整合
