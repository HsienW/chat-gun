# Chat Gun

<p align="center">
  <img src="./assets/chat-gun-logo.webp" alt="chat-gun" width="720"/>
</p>

<p align="center">
  <a href="./README.en.md">English</a> | 
  <a href="./README.md">繁體中文</a> | 
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-22C55E" alt="License" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7-3178C6" alt="TypeScript" /></a>
  <a href="https://langchain-ai.github.io/langgraphjs/"><img src="https://img.shields.io/badge/LangGraph-JS-06B6D4" alt="LangGraph" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-Protocol-111827" alt="MCP" /></a>
  <a href="https://github.com/QwenLM/Qwen"><img src="https://img.shields.io/badge/Qwen-Model_Provider-1E3A8A" alt="Qwen" /></a>
  <a href="https://docs.tavily.com/documentation/api-reference/endpoint/search"><img src="https://img.shields.io/badge/Tavily-Search_API-BE185D" alt="Tavily" /></a>
  <a href="https://brave.com/search/api/"><img src="https://img.shields.io/badge/Brave_Search-MCP-FB542B" alt="Brave Search" /></a>
  <a href="https://opentelemetry.io/"><img src="https://img.shields.io/badge/OpenTelemetry-Observability-8A7600" alt="OpenTelemetry" /></a>
  <a href="https://github.com/comet-ml/opik"><img src="https://img.shields.io/badge/Opik-Tracing_%26_Evaluation-6F4CFF" alt="Opik" /></a>
  <a href="https://www.alibabacloud.com/help/en/model-studio/models"><img src="https://img.shields.io/badge/qwen--plus-Generation-1E3A8A" alt="qwen-plus" /></a>
  <a href="https://www.alibabacloud.com/help/en/model-studio/models"><img src="https://img.shields.io/badge/text--embedding--v4-Embedding-0EA5E9" alt="text-embedding-v4" /></a>
  <a href="https://www.alibabacloud.com/help/en/model-studio/models"><img src="https://img.shields.io/badge/qwen3--rerank-Rerank-0EA5E9" alt="qwen3-rerank" /></a>
  <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/PostgreSQL-16-336791" alt="PostgreSQL" /></a>
</p>

<p align="center">
  <a href="#功能演示">功能演示</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#快速開始">快速開始</a> ·
  <a href="#業務場景">業務場景</a> ·
  <a href="#架構設計">架構設計</a> ·
  <a href="#評測">評測</a> ·
  <a href="#安全與限制">安全與限制</a> ·
  <a href="#文件指引">文件指引</a>
</p>

---

Chat Gun 是一套由 Frontend、BFF 與 LangGraph Runtime 組成的全端 Agent 應用。
- Agent 平台：是底層能力，負責工具統一調度、檢索答案可回溯、會改變外部狀態的操作必須先經人工核准，並以邏輯冪等鍵保證重複送出只生效一次。
- AI 業務場景：是上層功能，建立在平台能力之上，目前有兩個入口 **Gun Chat** 處理一般對話與深度研究，**Gun Shop** 是一條從商品查詢、政策問答到退款核准的 AI 智能客服鏈路。
- 所有模型呼叫、工具執行與憑證解析都在 Server 端完成，前端只透過 BFF 與 Runtime 通訊。業務場景的語料與訂單資料為合成資料，訂單工具為模擬；機制是真實的，展示它們的業務情境是模擬的。

## 功能演示

<p align="center">
  <img src="./assets/chat-gun-demo.webp" alt="Chat Gun demo" width="1280" />
</p>

<p align="center">
  <img src="./assets/chat-gun-01.png" alt="Entry screen" width="1280" />
</p>

<p align="center">
  <img src="./assets/chat-gun-02.png" alt="Entry screen" width="1280" />
</p>

<p align="center">
  <img src="./assets/chat-gun-03.png" alt="Entry screen" width="1280" />
</p>

**其他操作的畫面見[操作畫面](./docs/gun-shop.md#操作畫面)。**

## 核心能力

### Agent 平台: Harness

- **Agent-workflows**：五個 Graph 共用同一套 Runtime。
    - Deep Researcher 負責多步驟研究與引用驗證。
    - Chat Assistant 處理一般對話。
    - Shopping Assistant 依意圖分流商品查詢、政策問答與訂單操作。
    - Math Solver 執行算式與數值運算。
    - MCP Agent 透過 Tool Calling 使用 native 與 MCP tools。
- **Streaming**：即時串流回答與執行活動，可中途取消，錯誤以明確狀態呈現。
- **HITL**：Human-in-the-Loop 訂單操作先經人工核准；天氣地點不明確時列出候選地點請使用者確認，再接續原本的對話。
- **Multimodal input**：接受 PNG、JPEG 與 WebP 圖片，經 vision model 分析後納入回答或研究流程。
- **Model providers**：支援 Qwen、OpenAI-compatible 與 CCR-compatible endpoints，由 LLM Gateway 統一處理模型能力檢查與呼叫。
- **Native Tools 與 MCP**：內建計算、網路搜尋（Tavily）、網頁擷取、天氣、知識庫檢索與模擬訂單操作；可選擇載入 Filesystem 與 Brave Search MCP Server。見 [Tools 與 MCP](./docs/tools-and-mcp.md)。
- **Agent / Tool SDK**：以版本化 manifest 宣告輸入輸出、副作用類別、所需權限與執行條件；工具只授予宣告它的 Agent。見 [`@gun-ai/harness-sdk`](https://www.npmjs.com/package/@gun-ai/harness-sdk)。

### Agent 平台: Runtime 治理
- **檢索與拒答**：PostgreSQL + pgvector 向量索引，經 `qwen3-rerank` 與證據門檻後綁定引用，無依據時明確拒答。Recall@5 1.000、MRR 0.917、引用準確率 1.000、誤拒率 0.100（test split）。見[知識庫檢索](./docs/retrieval.md)與[評測](./docs/evaluation.md#檢索品質)。
- **副作用**：外部狀態變更須先取得可持久化的人工核准，模型只能請求、不能記錄核准。見[Gun Shop 流程走查](./docs/gun-shop.md#gun-shop-流程走查)。
- **冪等與結果**：冪等鍵由業務操作推導，並行重複送出只生效一次；提交後失去回應時進入 `outcome_unknown` 並建立對帳任務。見[並行與回歸驗證](./docs/gun-shop.md#並行與回歸驗證)。
- **可信邊界**： BFF 將 API key 映射為可信身分，集中處理 CORS、限流、逾時與取消傳遞，並拒絕客戶端直接寫入對話 state。見 [BFF](./docs/bff.md#對話-state-的寫入防護)。
- **觀測與評測**： 提供 Metrics、OpenTelemetry 與 Opik tracing；評測分 deterministic（驗證 runtime 保證）與 live（衡量模型品質）兩層，各自記錄資料集、模型與 prompt 版本。模型評分經 10 題人工複核，評審一致率 0.600，因此忠實度不發布。見[評測](./docs/evaluation.md)。

### 業務場景：Gun Shop AI 智能客服

使用 Agent 平台的能力搭建的業務場景，不新增 Runtime 機制。它的數字同時是平台保證的端到端驗證。

- **售後客服鏈路**： 意圖分流 → 商品卡片 → 政策問答（帶引用）→ 退款申請 → 人工核准 → 冪等執行 → 狀態卡片。live 意圖路由準確率 1.000（18 輪）、禁止結果 0。見[流程走查](./docs/gun-shop.md#gun-shop-流程走查)與[流程評測](./docs/evaluation.md#流程評測)。
- **訂單操作狀態**： 等待核准、執行中、已確認、已去重、失敗、生效前已取消、結果未知、核准被拒、核准逾期，九種狀態在介面上互相可辨識；不提供 undo。deterministic test 10 / 10（含核准被拒、逾期、生效前取消）。見[操作狀態](./docs/gun-shop.md#gun-shop-流程走查)與[訂單冪等整合測試](./backend/src/agents/shopping-assistant/order-idempotency.integration.test.ts)。
- **模擬邊界**： 商品與政策答案只落在合成語料並帶引用；退款與取消作用在模擬訂單系統，不觸及真實交易。見[範圍與限制](./docs/scope-and-limitations.md)。

## 快速開始

> 📌
> 目前預設僅本地開發。公開部署前，請啟用 Authentication、設定明確的 CORS allowlist、妥善管理 Secrets 與資料庫憑證，並依部署架構設計配置共享 Rate limiting、TLS 與 Reverse Proxy。若需要跨重啟或多實例恢復 Agent 執行，請改用 durable checkpointer。

- Node >= 22
- npm >= 10.8.x
- Docker 與 Docker Compose
- 根目錄的 `.env` 填入 `QWEN_API_KEY`、`TAVILY_API_KEY` 與具 LangGraph Cloud 存取權的 `LANGSMITH_API_KEY`
- 替代授權方式見[完整安裝說明](./docs/getting-started.md#docker-compose)。

```bash
git clone https://github.com/HsienW/chat-gun.git
cd chat-gun
npm --prefix backend ci
cp backend/.env.example backend/.env
# 在 backend/.env 填入 QWEN_API_KEY，並設定下列主機連線：
# DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
# KNOWLEDGE_DATABASE_URL=postgresql://postgres:postgres@localhost:5434/knowledge
docker compose up -d langgraph-postgres knowledge-postgres
npm --prefix backend run migrations:up
npm --prefix backend run knowledge:corpus
npm --prefix backend run knowledge:ingest
docker compose up --build
```

- 開啟 <http://localhost:8123/app/>，首頁即為 Gun Chat 與 Gun Shop 兩個入口。在 Gun Shop 輸入一個退款需求，就能看到核准卡片與之後的狀態卡片。

- 本機匯入使用主機 port `5433` / `5434`；容器內的知識庫連線必須使用 `knowledge-postgres:5432`，不要把主機的 `KNOWLEDGE_DATABASE_URL` 傳入容器。本地三終端啟動、PowerShell 指令與測試入口見[快速開始](./docs/getting-started.md)。

##  業務場景

**AI 進入業務場景時重點往往是落在 Tool 被呼叫之後發生的事。**

以 Gun Shop AI 智能客服為例子，下表是「模型輸出工具呼叫就直接執行」的做法：

| 情境 | 直接執行工具呼叫 | Chat Gun |
| --- | --- | --- |
| 模型輸出一個退款呼叫 | 立即執行 | 進入 `awaiting_approval`，核准後才提交 |
| 同一筆退款被重複或並行送出 | 可能執行多次 | 只生效一次，之後的送出回傳 `deduplicated` 並指向原操作 |
| 提交後連線中斷 | 重試或回報失敗 | 進入 `outcome_unknown` 並建立對帳任務，不重試、不回報成功 |
| 客戶端改寫對話 state 冒充核准 | 取決於實作 | BFF 拒絕 state 寫入，核准由 Server 端紀錄驗證 |
| 語料中沒有答案 | 可能改用模型自身知識作答 | 明確拒答 |
| 答案的出處 | 文字描述 | 每個引用解析回已儲存的片段與來源版本 |

**1. 模型產生的是請求，不是副作用。** 退款與取消的工具呼叫會先停在核准；核准紀錄存在 Server 端並與對話綁定，只能消費一次。提交由 Tool Dispatch 在核准後執行，結果寫入 side-effect ledger。

**2. 冪等鍵描述業務操作，不描述一次呼叫。** 鍵由操作種類、訂單與正規化後的明細推導，不含重試次數或呼叫識別，所以並行或重複的送出會收斂成同一筆操作。提交後失去回應時，系統承認「不知道」，而不是猜一個結果。

**3. 答案必須能回溯到語料。** 候選片段經 rerank 後仍須通過證據門檻，每個引用都綁定到已儲存的片段與其來源版本；沒有片段達標就明確拒答。

## 架構設計

- **Frontend**： 負責入口、串流與卡片呈現，不持有任何模型、工具或資料庫憑證。
- **BFF**： 是唯一對外邊界：驗證身分、限流、逾時與取消傳遞，並拒絕客戶端寫入對話 state。
- **LangGraph Runtime** ：承載五個 Graph；入口決定使用哪一個 Graph，不需要額外的模型路由。
- **Tool Registry**： 統一調度所有工具；會改變外部狀態的工具先進入人工核准，提交後寫入 ledger。

下圖說明 Chat Gun 的請求從前端到模型 Provider 會經過哪些層、工具與副作用在哪裡收斂，以及可觀測性接在哪裡。

```mermaid
flowchart LR
  B["前端"]
  F["Frontend<br/>Vite + React 19"]
  G["BFF<br/>認證 · CORS · 限流 · 逾時 · State 寫入防護"]
  L["LangGraph Agent Server"]
  A1["deep_researcher"]
  A2["chatbot"]
  A3["math_agent"]
  A4["mcp_agent"]
  A5["shopping_assistant"]
  GW["LLM Gateway"]
  Q["Qwen"]
  O["OpenAI-compatible"]
  C["CCR"]
  TR["Tool Registry<br/>統一 Tool Dispatch"]
  NT["原生工具"]
  KB["kb_search"]
  OD["訂單工具<br/>外部狀態變更"]
  MT["MCP servers"]
  EM["Embedding · Rerank"]
  KS["知識庫<br/>PostgreSQL + pgvector"]
  HI["人工核准<br/>可持久化"]
  LG["Side-effect Ledger"]
  OT["OpenTelemetry"]
  OP["Opik"]

  B --> F
  F -->|"/api/langgraph/*"| G
  G --> L
  L --> A1
  L --> A2
  L --> A3
  L --> A4
  L --> A5
  A1 --> GW
  A2 --> GW
  A3 --> GW
  A4 --> GW
  A5 --> GW
  GW --> Q
  GW --> O
  GW --> C
  A1 --> TR
  A3 --> TR
  A4 --> TR
  A5 --> TR
  TR --> NT
  TR --> KB
  TR --> OD
  TR --> MT
  KB --> EM
  KB --> KS
  EM --> Q
  OD --> HI
  OD --> LG
  L -.->|"spans"| OT
  L -.->|"traces / evals"| OP
```

| 目錄 | 用途 | 本地預設 port |
| --- | --- | ---: |
| `frontend/` | 入口首頁、Chat UI、串流狀態、工具結果、商品與核准卡片、圖片輸入 | `5173` |
| `bff/` | API gateway、驗證、代理、逾時、限流與 state 寫入防護 | `8787` |
| `backend/` | LangGraph agents、模型整合、Tools、知識庫與 MCP | `2024` |

入口與 Graph 的對應關係見[入口與 Agents](./docs/gun-shop.md#入口與-agents)。

## 評測

**檢索品質（平台能力）：** 
- 資料集 `kb-eval-v1`（40 題，含拒答題）、語料 `kb-v1`（合成）、Embedding `text-embedding-v4`（1024 維）、Rerank `qwen3-rerank`、回答生成 `qwen-plus`。

以下僅列 **test split**

| 配置 | Recall@5 | MRR | 引用準確率 | 正確拒答率 | 誤拒率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `vector_only` | 0.863 | 0.796 | 1.000 | 1.000 | 0.300 |
| `vector_rerank` | 1.000 | 0.917 | 1.000 | 1.000 | 0.100 |

**流程評測（業務實作）**： 
  - deterministic test 10 / 10；live 意圖路由準確率 1.000（18 輪，`qwen3.7-plus`）、禁止結果 0。
  - 資料集 `chain-eval-v1`（15 題）、訂單資料 `synthetic-orders-v1`（合成）、prompt `shopping-intent-v1` / `shopping-policy-answer-v1`。

**已知限制**： live test split 3 / 10 通過，其餘 7 題為同一現象（訂單操作回傳空結果），尚未修正。同一組案例在 deterministic 層全數通過。

完整結果、執行次數、dev split、延遲、指標定義、忠實度未發布的原因、方法學與重跑方式見[評測](./docs/evaluation.md)。

## 安全與限制

**工具在行程內執行**： 作業系統層級沙箱尚未出貨；宣告為獨立行程執行的工具會在註冊或調度階段被明確拒絕，不會退回到行程內執行。接入 MCP 前請先讀[安全設定](./docs/tool-security-isolation.md)。

**範圍**：

- 語料與訂單資料為合成資料，不代表真實商品或營運規則。
- 訂單工具為模擬，沒有真實交易、付款或外部供應商整合。
- 不提供 undo；僅可在副作用發生前取消。
- 評測為離線回歸，數字代表受控合成資料集上的方法有效性，不代表正式環境表現。

尚未實作的操作歷史投影、自動對帳與選模機制見[範圍與限制](./docs/scope-and-limitations.md)。

## 文件指引

| 我想了解…                     | 從這裡開始 |
|---------------------------| --- |
| 在本機跑起來、執行測試               | [快速開始](./docs/getting-started.md) |
| 設定模型、知識庫、BFF 與 Frontend   | [設定](./docs/configuration.md) |
| 看 Gun Shop 的流程走查與操作狀態     | [Gun Shop](./docs/gun-shop.md) |
| 了解檢索管線、切塊、門檻與匯入續跑         | [知識庫檢索](./docs/retrieval.md) |
| 查看完整評測數據或重跑評測             | [評測](./docs/evaluation.md) |
| 理解請求流程、State 與 checkpoint | [執行架構](./docs/architecture.md) · [TypeScript + LangGraph](./docs/typescript-langgraph-architecture.md) |
| 確認可信身分、限流與 state 防護       | [BFF](./docs/bff.md) |
| 新增工具或接入 MCP               | [Tools 與 MCP](./docs/tools-and-mcp.md) · [安全設定](./docs/tool-security-isolation.md) |
| 接上 OpenTelemetry 或 Opik   | [可觀測性](./docs/observability.md) |
| 排除常見錯誤                    | [疑難排解](./docs/troubleshooting.md) |
| 查看完整限制清單                  | [範圍與限制](./docs/scope-and-limitations.md) |

## License

Apache License 2.0。詳見 [LICENSE](./LICENSE)。
