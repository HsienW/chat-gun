# Chat Gun

<p align="center">
  <img src="./assets/chat-gun-logo.jpg" alt="chat-gun" width="720"/>
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
  <a href="#快速开始">快速开始</a> ·
  <a href="#业务场景">业务场景</a> ·
  <a href="#架构设计">架构设计</a> ·
  <a href="#评测">评测</a> ·
  <a href="#安全与限制">安全与限制</a> ·
  <a href="#文档指引">文档指引</a>
</p>

---

Chat Gun 是一套由 Frontend、BFF 与 LangGraph Runtime 组成的全栈 Agent 应用。
- Agent 平台：是底层能力，负责工具统一调度、检索答案可回溯、会改变外部状态的操作必须先经人工审批，并以逻辑幂等键保证重复提交只生效一次。
- AI 业务场景：是上层功能，建立在平台能力之上，目前有两个入口 **Gun Chat** 处理一般对话与深度研究，**Gun Shop** 是一条从商品查询、政策问答到退款审批的 AI 智能客服链路。
- 所有模型调用、工具执行与凭证解析都在 Server 端完成，浏览器只通过 BFF 与 Runtime 通信。业务场景的语料与订单数据为合成数据，订单工具为模拟；机制是真实的，展示它们的业务情境是模拟的。

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

**其他操作的画面见[操作画面](./docs/gun-shop.md#操作畫面)（繁中）。**

## 核心能力

### Agent 平台: Harness

- **Agent-workflows**：五个 Graph 共用同一套 Runtime。
  - Deep Researcher 负责多步骤研究与引用验证。
  - Chat Assistant 处理一般对话。
  - Shopping Assistant 依意图分流商品查询、政策问答与订单操作。
  - Math Solver 执行算式与数值运算。
  - MCP Agent 通过 Tool Calling 使用 native 与 MCP tools。
- **Streaming**：实时流式输出回答与执行活动，可中途取消，错误以明确状态呈现。
- **HITL**：Human-in-the-Loop 订单操作先经人工审批；天气地点不明确时列出候选地点请用户确认，再接续原本的对话。
- **Multimodal input**：接受 PNG、JPEG 与 WebP 图片，经 vision model 分析后纳入回答或研究流程。
- **Model providers**：支持 Qwen、OpenAI-compatible 与 CCR-compatible endpoints，由 LLM Gateway 统一处理模型能力检查与调用。
- **Native Tools 与 MCP**：内置计算、网络搜索（Tavily）、网页抓取、天气、知识库检索与模拟订单操作；可选择加载 Filesystem 与 Brave Search MCP Server。见 [Tools 与 MCP](./docs/tools-and-mcp.md)（繁中）。
- **Agent／Tool SDK**：以版本化 manifest 声明输入输出、副作用类别、所需权限与执行条件；工具只授予声明它的 Agent。见 [`@gun-ai/harness-sdk`](https://www.npmjs.com/package/@gun-ai/harness-sdk)。

### Agent 平台: Runtime 治理
- **检索与拒答：**PostgreSQL + pgvector 存储向量索引，流程为「候选召回 → rerank → 证据门槛 → 引用绑定」；每个引用可回溯到已存储片段与来源版本，无依据时明确拒答。加入 `qwen3-rerank` 后 MRR 0.796 → 0.917、误拒率 0.30 → 0.10、引用准确率 1.000（test split）。见[检索评测](./docs/evaluation.md#檢索品質)（繁中）。
- **副作用：**外部状态变更必须先取得可持久化的人工审批；审批与对话绑定、只能消费一次，模型只能「请求」审批，不能「记录」审批。见[审批集成测试](./backend/src/runtime/authorization/confirmation-resume.integration.test.ts)。
- **幂等与结果：**幂等键由「操作种类＋订单＋规范化后的明细」推导，不含重试次数；并发重复提交只生效一次，第二次识别为去重。提交后失去响应时进入 `outcome_unknown` 并建立对账任务，不盲目重试、不回报成功。见[并发幂等集成测试](./backend/src/runtime/side-effect/business-effect-ledger.integration.test.ts)。
- **可信边界：**BFF 将 API key 映射为可信身份，集中处理 CORS、限流、超时与取消传递，并拒绝客户端直接写入对话 state。见 [BFF](./docs/bff.md#對話-state-的寫入防護)（繁中）。
- **观测与评测：**提供 Metrics、OpenTelemetry 与 Opik tracing；评测分 deterministic（验证 runtime 保证）与 live（衡量模型质量）两层，各自记录数据集、模型与 prompt 版本。模型评分经 10 题人工复核，评审一致率 0.600，因此忠实度不发布。见[评测](./docs/evaluation.md)（繁中）。

### 业务场景：Gun Shop AI 智能客服链路

使用 Agent 平台的能力搭建的业务场景，不新增 Runtime 机制。它的数字同时是平台保证的端到端验证。

- **售后客服链路：**意图分流 → 商品卡片 → 政策问答（带引用）→ 退款申请 → 人工审批 → 幂等执行 → 状态卡片。live 意图路由准确率 1.000（18 轮）、禁止结果 0。见[流程走查](./docs/gun-shop.md#gun-shop-流程走查)（繁中）与[流程评测](./docs/evaluation.md#流程評測)（繁中）。
- **订单操作状态：**等待审批、执行中、已确认、已去重、失败、生效前已取消、结果未知、审批被拒、审批逾期，九种状态在界面上互相可辨识；不提供 undo。deterministic test 10／10（含审批被拒、逾期、生效前取消）。见[操作状态](./docs/gun-shop.md#gun-shop-流程走查)（繁中）与[订单幂等集成测试](./backend/src/agents/shopping-assistant/order-idempotency.integration.test.ts)。
- **模拟边界：**商品与政策答案只来自合成语料并带引用；退款与取消作用在模拟订单系统，不触及真实交易。见[范围与限制](./docs/scope-and-limitations.md)（繁中）。

## 快速开始

> 📌
> 目前默认仅用于本地开发。公开部署前，请启用 Authentication、设置明确的 CORS allowlist、妥善管理 Secrets 与数据库凭证，并依部署架构设计配置共享 Rate limiting、TLS 与 Reverse Proxy。若需要跨重启或多实例恢复 Agent 执行，请改用 durable checkpointer。

- Node >= 22
- npm >= 10.8.x
- Docker 与 Docker Compose
- 根目录的 `.env` 填入 `QWEN_API_KEY`、`TAVILY_API_KEY` 与具 LangGraph Cloud 访问权限的 `LANGSMITH_API_KEY`
- 替代授权方式见[完整安装说明](./docs/getting-started.md#docker-compose)（繁中）。

```bash
git clone https://github.com/HsienW/chat-gun.git
cd chat-gun
npm --prefix backend ci
cp backend/.env.example backend/.env
# 在 backend/.env 填入 QWEN_API_KEY，并设置下列主机连接：
# DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
# KNOWLEDGE_DATABASE_URL=postgresql://postgres:postgres@localhost:5434/knowledge
docker compose up -d langgraph-postgres knowledge-postgres
npm --prefix backend run migrations:up
npm --prefix backend run knowledge:corpus
npm --prefix backend run knowledge:ingest
docker compose up --build
```

- 打开 <http://localhost:8123/app/>，首页即为 Gun Chat 与 Gun Shop 两个入口。在 Gun Shop 输入一个退款需求，就能看到审批卡片与之后的状态卡片。

- 本机导入使用主机 port `5433`／`5434`；容器内的知识库连接必须使用 `knowledge-postgres:5432`，不要把主机的 `KNOWLEDGE_DATABASE_URL` 传入容器。本地三终端启动、PowerShell 命令与测试入口见[快速开始](./docs/getting-started.md)（繁中）。

## 业务场景

**AI 进入业务场景时，重点往往落在 Tool 被调用之后发生的事。**

以 Gun Shop AI 智能客服为例，下表对比「模型输出工具调用就直接执行」的做法：

| 情境 | 直接执行工具调用 | Chat Gun |
| --- | --- | --- |
| 模型输出一个退款调用 | 立即执行 | 进入 `awaiting_approval`，审批后才提交 |
| 同一笔退款被重复或并发提交 | 可能执行多次 | 只生效一次，之后的提交返回 `deduplicated` 并指向原操作 |
| 提交后连接中断 | 重试或回报失败 | 进入 `outcome_unknown` 并建立对账任务，不重试、不回报成功 |
| 客户端改写对话 state 冒充审批 | 取决于实现 | BFF 拒绝 state 写入，审批由 Server 端记录验证 |
| 语料中没有答案 | 可能改用模型自身知识作答 | 明确拒答 |
| 答案的出处 | 文字描述 | 每个引用解析回已存储的片段与来源版本 |

**1. 模型产生的是请求，不是副作用。** 退款与取消的工具调用会先停在审批；审批记录存在 Server 端并与对话绑定，只能消费一次。提交由 Tool Dispatch 在审批后执行，结果写入 side-effect ledger。

**2. 幂等键描述业务操作，不描述一次调用。** 键由操作种类、订单与规范化后的明细推导，不含重试次数或调用标识，所以并发或重复的提交会收敛成同一笔操作。提交后失去响应时，系统承认「不知道」，而不是猜一个结果。

**3. 答案必须能回溯到语料。** 候选片段经 rerank 后仍须通过证据门槛，每个引用都绑定到已存储的片段与其来源版本；没有片段达标就明确拒答。

## 架构设计

- **Frontend：** 负责入口、流式输出与卡片呈现，不持有任何模型、工具或数据库凭证。
- **BFF：** 是唯一对外边界：验证身份、限流、超时与取消传递，并拒绝客户端写入对话 state。
- **LangGraph Runtime：** 承载五个 Graph；入口决定使用哪一个 Graph，不需要额外的模型路由。
- **Tool Registry：** 统一调度所有工具；会改变外部状态的工具先进入人工审批，提交后写入 ledger。

下图说明 Chat Gun 的请求从前端到模型 Provider 会经过哪些层、工具与副作用在哪里收敛，以及可观测性接在哪里。

```mermaid
flowchart LR
  B["前端"]
  F["Frontend<br/>Vite + React 19"]
  G["BFF<br/>认证 · CORS · 限流 · 超时 · State 写入防护"]
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
  TR["Tool Registry<br/>统一 Tool Dispatch"]
  NT["原生工具"]
  KB["kb_search"]
  OD["订单工具<br/>外部状态变更"]
  MT["MCP servers"]
  EM["Embedding · Rerank"]
  KS["知识库<br/>PostgreSQL + pgvector"]
  HI["人工审批<br/>可持久化"]
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

| 目录 | 用途 | 本地默认 port |
| --- | --- | ---: |
| `frontend/` | 入口首页、Chat UI、流式状态、工具结果、商品与审批卡片、图片输入 | `5173` |
| `bff/` | API gateway、验证、代理、超时、限流与 state 写入防护 | `8787` |
| `backend/` | LangGraph agents、模型集成、Tools、知识库与 MCP | `2024` |

入口与 Graph 的对应关系见[入口与 Agents](./docs/gun-shop.md#入口與-agents)（繁中）。

## 评测

**检索质量（平台能力）：**
- 数据集 `kb-eval-v1`（40 题，含拒答题）、语料 `kb-v1`（合成）、Embedding `text-embedding-v4`（1024 维）、Rerank `qwen3-rerank`、回答生成 `qwen-plus`。

以下仅列 **test split**

| 配置 | Recall@5 | MRR | 引用准确率 | 正确拒答率 | 误拒率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `vector_only` | 0.863 | 0.796 | 1.000 | 1.000 | 0.300 |
| `vector_rerank` | 1.000 | 0.917 | 1.000 | 1.000 | 0.100 |

**流程评测（业务实现）：**
- deterministic test 10／10；live 意图路由准确率 1.000（18 轮，`qwen3.7-plus`）、禁止结果 0。
- 数据集 `chain-eval-v1`（15 题）、订单数据 `synthetic-orders-v1`（合成）、prompt `shopping-intent-v1`／`shopping-policy-answer-v1`。

**已知限制：** live test split 3／10 通过，其余 7 题为同一现象（订单操作返回空结果），尚未修正。同一组案例在 deterministic 层全部通过。

完整结果、执行次数、dev split、延迟、指标定义、忠实度未发布的原因、方法学与重跑方式见[评测](./docs/evaluation.md)（繁中）。

## 安全与限制

**工具在进程内执行：** 操作系统级沙箱尚未发布；声明为独立进程执行的工具会在注册或调度阶段被明确拒绝，不会退回到进程内执行。接入 MCP 前请先读[安全设置](./docs/tool-security-isolation.md)（繁中）。

**范围：**

- 语料与订单数据为合成数据，不代表真实商品或运营规则。
- 订单工具为模拟，没有真实交易、付款或外部供应商集成。
- 不提供 undo；仅可在副作用发生前取消。
- 评测为离线回归，数字代表受控合成数据集上的方法有效性，不代表生产环境表现。

尚未实现的操作历史投影、自动对账与选模机制见[范围与限制](./docs/scope-and-limitations.md)（繁中）。

## 文档指引

| 我想了解… | 从这里开始 |
| --- | --- |
| 在本机跑起来、执行测试 | [快速开始](./docs/getting-started.md)（繁中） |
| 设置模型、知识库、BFF 与 Frontend | [设置](./docs/configuration.md)（繁中） |
| 看 Gun Shop 的流程走查与操作状态 | [Gun Shop](./docs/gun-shop.md)（繁中） |
| 了解检索管线、切块、门槛与导入续跑 | [知识库检索](./docs/retrieval.md)（繁中） |
| 查看完整评测数据或重跑评测 | [评测](./docs/evaluation.md)（繁中） |
| 理解请求流程、State 与 checkpoint | [执行架构](./docs/architecture.md)（繁中） · [TypeScript + LangGraph](./docs/typescript-langgraph-architecture.md)（繁中） |
| 确认可信身份、限流与 state 防护 | [BFF](./docs/bff.md)（繁中） |
| 新增工具或接入 MCP | [Tools 与 MCP](./docs/tools-and-mcp.md)（繁中） · [安全设置](./docs/tool-security-isolation.md)（繁中） |
| 接上 OpenTelemetry 或 Opik | [可观测性](./docs/observability.md)（繁中） |
| 排除常见错误 | [疑难排解](./docs/troubleshooting.md)（繁中） |
| 查看完整限制清单 | [范围与限制](./docs/scope-and-limitations.md)（繁中） |

## License

Apache License 2.0。详见 [LICENSE](./LICENSE)。
