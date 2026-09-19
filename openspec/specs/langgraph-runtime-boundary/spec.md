# langgraph-runtime-boundary Specification

## Purpose

規範以目前程式碼與 `langgraph dev` 實證判定 LangGraph Runtime 和 Chat-Gun 自建 Runtime 的責任邊界，並明確保留正式 Agent Server 持久化等尚未取得 live 證據的限制。

## Requirements
### Requirement: 現況盤點（Graph 編譯與 Checkpointer 使用）

Coordinator SHALL 以原始碼分析盤點目前所有 Graph 的編譯方式與 checkpointer 使用，作為 Decision Record 的靜態證據。

#### Scenario: 四個 Graph 的編譯差異確認

GIVEN `backend/src/agents/` 下的 `chatbot`、`math_agent`、`mcp_agent`、`deep_researcher` 四個 Graph
WHEN 分析其 `builder.compile(...)` 呼叫
THEN Decision Record SHALL 明確記錄：
- 哪些 Graph 以「無 explicit checkpointer」方式編譯
- 哪個 Graph 以 explicit checkpointer 編譯，且其 checkpointer 型別（in-memory `MemorySaver` 或其他）
AND 記錄 `langgraph.json` 的 Graph 註冊、configurable headers，以及 `docker-compose.yml` 的 infra 組合（PG／Redis／langgraph-api）作為靜態事實

#### Scenario: 既有自建原語的盤點

GIVEN Chat-Gun 已存在的自建 Runtime 模組（Task/Step、Retry Budget、Idempotency/Audit、Compensation、Distributed Step Lock、Side-effect Ledger、Interaction Runtime、Context Budget、Long-term Memory Governance、Operations）
WHEN 建立 Decision Record
THEN 每個自建模組 SHALL 被標記其聲稱的責任範圍
AND 在責任歸屬表中與 LangGraph native 能力對應，以暴露潛在的重複或缺口

---

### Requirement: langgraph dev 生命週期實證

Coordinator SHALL 對 `langgraph dev` 開發伺服器執行完整生命週期，證明 create Run → stream → interrupt → restart → resume → cancel → terminal lookup 的行為與 Graph-level checkpoint 邊界。

#### Scenario: 完整生命週期循環

GIVEN 一個運作中的 `langgraph dev` 開發伺服器（`backend` 內以 `langgraphjs dev --no-browser` 啟動，`http://localhost:2024`）
WHEN 執行 create Run、stream、interrupt、restart、resume、cancel 與 terminal lookup
THEN 每一步的行為 SHALL 被記錄為可重播的證據
AND Decision Record SHALL 標明每一步是由 LangGraph native、Chat-Gun 模組，還是兩者協作完成

#### Scenario: 無法執行 live spike 時的誠實記錄

GIVEN live spike 因環境或啟動限制無法執行
WHEN 建立 Decision Record
THEN 對應能力 SHALL 標記為「未驗證」，MUST NOT 宣稱已通過

---

### Requirement: Checkpointer 與持久化邊界驗證

Coordinator SHALL 驗證 Graph 在 `langgraph dev` 下的實際 checkpoint／resume 行為，明確區分兩類 Graph 來源：無 explicit checkpointer（`chatbot`／`math_agent`／`mcp_agent`）與有 explicit checkpointer（`deep_researcher` 的 `MemorySaver`）。

#### Scenario: 無 explicit checkpointer Graph 的中斷與恢復

GIVEN 一個以 `builder.compile()` 編譯、無 explicit checkpointer 的 Graph
WHEN 在 `langgraph dev` 上執行一次 run（含 interrupt）
THEN Decision Record SHALL 記錄其 checkpoint／resume 由誰提供、粒度如何、跨正常重啟是否保留 State
AND SHALL 記錄 checkpoint identity（`checkpoint_id`／`checkpoint_ns`）在 restart 前後與 resume 後的變化

#### Scenario: 有 explicit checkpointer Graph 的中斷與恢復

GIVEN 一個以 explicit checkpointer 編譯的 Graph（`deep_researcher` 的 `MemorySaver`）
WHEN 在 `langgraph dev` 上執行 interrupt 後 resume
THEN Decision Record SHALL 記錄 checkpoint 覆蓋哪些 State 欄位、resume 後是否正確恢復、副作用是否重複

#### Scenario: Server-managed persistence 超出範圍的誠實標記

GIVEN 正式 Agent Server（`langgraphjs-api:20`）的 server-managed PostgreSQL／Redis persistence 因 Dockerfile 建置與 LangSmith 授權問題無法實證
WHEN 建立 Decision Record
THEN 該維度 SHALL 標記為「未驗證（超出 langgraph dev 驗收範圍，另立後續 Change）」
AND MUST NOT 以 `langgraph dev` 的 in-memory 行為推論正式部署的持久化行為
AND MUST NOT 將 `MemorySaver` 分類為 override／complement／conflict（此分類取決於 server-managed persistence 實證，標記為「未驗證」）

---

### Requirement: 原生訊號到 Chat-Gun 概念的映射

Coordinator SHALL 將 LangGraph native 的 Queue／Worker／Run／Thread／Checkpointer／Store 訊號，映射到 Chat-Gun 的 Task／Step／ownership／operations 概念。

#### Scenario: 責任歸屬表產出

GIVEN 靜態盤點與 `langgraph dev` 動態實證的完整結果
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
AND 無法以 `langgraph dev` 證據支撐的維度 SHALL 標明「未驗證（超出 langgraph dev 範圍）」，MUST NOT 以官方文件或既有結論升格為已驗證

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
THEN SHALL 涵蓋並分類以下 drills，且每項標明其實證等級（V 實測／S 靜態推理／未驗證）：
- first checkpoint 前 process 終止
- 等待 interrupt 期間 process 終止（V 涵蓋「正常停止後重啟」；強制 process kill 標記「未驗證」）
- Tool dispatch 後、Tool result 持久化前 process 終止（未以真實副作用實證，標記為 side-effect ambiguity）
- 以 compatible manifest 的部署重啟（S＋deterministic 測試）
- 以 incompatible manifest 的部署重啟（S＋deterministic 測試）
- resume 期間 PostgreSQL 或 Redis 不可用（超出 langgraph dev 範圍，標記「未驗證」，另立後續 Change）
AND 每個 drill SHALL 標明是 replay-safe 還是存在 side-effect ambiguity
AND 每個 drill SHALL 記錄失敗歸屬（Agent Server／Backend／Tool adapter／Operations）

---

### Requirement: Decision Record 產出

Coordinator SHALL 將所有驗證結果整理為單一 Decision Record（`docs/decisions/current-langgraph-runtime-boundary.md`）。

#### Scenario: Decision Record 完整性

GIVEN 所有盤點、實證、映射與 failure drills 結果
WHEN 撰寫 Decision Record
THEN 文件 SHALL 包含：
- 驗證時的 LangGraph 版本、啟動方式（`langgraph dev`）與部署資訊
- 責任歸屬表（Authority／Chat-Gun extension／Failure owner）
- Run／Task／Step／ToolExecution／checkpoint identity 的 ownership 地圖
- `MemorySaver` 的行為描述與處置建議（override／complement／conflict 標記「未驗證」）
- 每項自建責任「補原生缺口」的正當性證據或原始碼引用
- 「未驗證（超出 langgraph dev 驗收範圍）」的明確清單（含 server-managed persistence、worker lease、強制 kill durability）
AND 每個結論 SHALL 有驗證證據或原始碼引用

#### Scenario: X12 前 review gate

GIVEN Decision Record 完成
WHEN 進入 X12 前
THEN Decision Record SHALL 通過獨立架構審查（review-plan）
AND 未通過審查時 MUST NOT 開始 X12 的 application code 整合
