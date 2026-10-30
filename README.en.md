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
  <a href="#feature-demo">Feature Demo</a> ·
  <a href="#capabilities">Capabilities</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#business-scenario">Business Scenario</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#evaluation">Evaluation</a> ·
  <a href="#security-and-limitations">Security and Limitations</a> ·
  <a href="#documentation-guide">Documentation Guide</a>
</p>

---

Chat Gun is a full-stack agent application composed of a Frontend, a BFF, and a LangGraph Runtime.
- Agent platform: the underlying capabilities handle unified tool dispatch, make retrieved answers traceable, require human approval before operations that change external state, and use a logical idempotency key to ensure duplicate submissions take effect only once.
- AI business scenarios: the application features built on top of the platform capabilities. There are currently two entry points: **Gun Chat** handles general conversation and deep research, and **Gun Shop** is an AI customer service chain that runs from product lookup and policy Q&A to refund approval.
- All model calls, tool executions, and credential resolution happen on the server; the frontend communicates with the Runtime only through the BFF. The corpus and order data used by the business scenarios are synthetic, and the order tools are simulated; the mechanisms are real, while the business context used to demonstrate them is simulated.

## Feature Demo

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

**Screens for other operations are in [Operation Screens](./docs/gun-shop.md#操作畫面) (Traditional Chinese).**

## Capabilities

### Agent Platform: Harness

- **Agent-workflows**: five Graphs share the same Runtime.
  - Deep Researcher performs multi-step research and citation verification.
  - Chat Assistant handles general conversation.
  - Shopping Assistant routes by intent across product lookup, policy Q&A, and order operations.
  - Math Solver evaluates expressions and performs numerical calculations.
  - MCP Agent uses native and MCP tools through Tool Calling.
- **Streaming**: answers and execution activity stream in real time, runs can be cancelled midway, and errors are presented as explicit states.
- **HITL**: Human-in-the-Loop order operations require human approval first; when a weather location is ambiguous, candidate locations are listed for the user to confirm before the original conversation resumes.
- **Multimodal input**: accepts PNG, JPEG, and WebP images, which are analyzed by a vision model and incorporated into the answer or research flow.
- **Model providers**: supports Qwen, OpenAI-compatible, and CCR-compatible endpoints; the LLM Gateway handles model capability checks and calls in one place.
- **Native Tools and MCP**: built-in calculation, web search (Tavily), web page extraction, weather, knowledge base retrieval, and simulated order operations; Filesystem and Brave Search MCP Servers can optionally be loaded. See [Tools and MCP](./docs/tools-and-mcp.md) (Traditional Chinese).
- **Agent / Tool SDK**: a versioned manifest declares inputs and outputs, side-effect class, required permissions, and execution conditions; a tool is granted only to the Agent that declares it. See [`@gun-ai/harness-sdk`](https://www.npmjs.com/package/@gun-ai/harness-sdk).

### Agent Platform: Runtime Governance
- **Retrieval and refusal:** PostgreSQL + pgvector provides the vector index; citations are bound after `qwen3-rerank` and evidence thresholds, with explicit refusal when evidence is insufficient. Recall@5 1.000, MRR 0.917, citation accuracy 1.000, false refusal rate 0.100 (test split). See [knowledge base retrieval](./docs/retrieval.md) (Traditional Chinese) and [evaluation](./docs/evaluation.md#檢索品質) (Traditional Chinese).
- **Side effects:** external state changes require persistable human approval first; the model can request approval but cannot record it. See the [Gun Shop flow walkthrough](./docs/gun-shop.md#gun-shop-流程走查) (Traditional Chinese).
- **Idempotency and outcomes:** the idempotency key is derived from the business operation, and concurrent duplicate submissions take effect only once; losing the response after submission puts the operation into `outcome_unknown` and creates a reconciliation task. See [concurrency and regression verification](./docs/gun-shop.md#並行與回歸驗證) (Traditional Chinese).
- **Trust boundary:** the BFF maps API keys to trusted identities, centralizes CORS, rate limiting, timeouts, and cancellation propagation, and rejects direct client writes to conversation state. See [BFF](./docs/bff.md#對話-state-的寫入防護) (Traditional Chinese).
- **Observability and evaluation:** provides Metrics, OpenTelemetry, and Opik tracing; evaluation has two layers, deterministic (verifying runtime guarantees) and live (measuring model quality), each recording its dataset, model, and prompt versions. Model grading was reviewed by humans on 10 questions with a judge agreement rate of 0.600, so faithfulness is not published. See [Evaluation](./docs/evaluation.md) (Traditional Chinese).

### Business Scenario: Gun Shop AI Customer Service

A business scenario built with the Agent platform's capabilities, adding no new Runtime mechanisms. Its numbers also serve as end-to-end verification of the platform guarantees.

- **After-sales customer service chain:** intent routing → product cards → policy Q&A (with citations) → refund request → human approval → idempotent execution → status card. Live intent routing accuracy 1.000 (18 turns), prohibited outcomes 0. See the [flow walkthrough](./docs/gun-shop.md#gun-shop-流程走查) (Traditional Chinese) and [flow evaluation](./docs/evaluation.md#流程評測) (Traditional Chinese).
- **Order operation states:** awaiting approval, executing, confirmed, deduplicated, failed, cancelled before taking effect, outcome unknown, approval rejected, and approval expired — nine states that are mutually distinguishable in the interface; undo is not provided. Deterministic test 10 / 10 (including approval rejected, expired, and cancelled before taking effect). See [operation states](./docs/gun-shop.md#gun-shop-流程走查) (Traditional Chinese) and the [order idempotency integration test](./backend/src/agents/shopping-assistant/order-idempotency.integration.test.ts).
- **Simulation boundary:** product and policy answers come only from the synthetic corpus and carry citations; refunds and cancellations act on a simulated order system and never touch real transactions. See [Scope and Limitations](./docs/scope-and-limitations.md) (Traditional Chinese).

## Quick Start

> 📌
> The current defaults are for local development only. Before any public deployment, enable Authentication, configure an explicit CORS allowlist, manage Secrets and database credentials properly, and configure shared Rate limiting, TLS, and a Reverse Proxy according to your deployment architecture. If Agent runs need to resume across restarts or multiple instances, switch to a durable checkpointer.

- Node >= 22
- npm >= 10.8.x
- Docker and Docker Compose
- Fill in `QWEN_API_KEY`, `TAVILY_API_KEY`, and a `LANGSMITH_API_KEY` with LangGraph Cloud access in the root `.env`
- For alternative authorization methods, see the [full installation guide](./docs/getting-started.md#docker-compose) (Traditional Chinese).

```bash
git clone https://github.com/HsienW/chat-gun.git
cd chat-gun
npm --prefix backend ci
cp backend/.env.example backend/.env
# Fill in QWEN_API_KEY in backend/.env and set the following host connections:
# DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
# KNOWLEDGE_DATABASE_URL=postgresql://postgres:postgres@localhost:5434/knowledge
docker compose up -d langgraph-postgres knowledge-postgres
npm --prefix backend run migrations:up
npm --prefix backend run knowledge:corpus
npm --prefix backend run knowledge:ingest
docker compose up --build
```

- Open <http://localhost:8123/app/>; the home page shows the two entry points, Gun Chat and Gun Shop. Enter a refund request in Gun Shop to see the approval card and the status card that follows.

- Local ingestion uses host ports `5433` / `5434`; the knowledge base connection inside containers must use `knowledge-postgres:5432`, so do not pass the host `KNOWLEDGE_DATABASE_URL` into the container. For the local three-terminal startup, PowerShell commands, and test entry points, see [Quick Start](./docs/getting-started.md) (Traditional Chinese).

## Business Scenario

**When AI enters a business scenario, what matters most is often what happens after a Tool is called.**

Taking the Gun Shop AI customer service as an example, the table below compares it with the approach of "executing a tool call as soon as the model outputs it":

| Situation | Execute the tool call directly | Chat Gun |
| --- | --- | --- |
| The model outputs a refund call | Executes immediately | Enters `awaiting_approval` and submits only after approval |
| The same refund is submitted repeatedly or concurrently | May execute multiple times | Takes effect only once; later submissions return `deduplicated` and point to the original operation |
| The connection drops after submission | Retries or reports failure | Enters `outcome_unknown` and creates a reconciliation task; does not retry and does not report success |
| The client rewrites conversation state to fake an approval | Depends on the implementation | The BFF rejects the state write; approval is verified against server-side records |
| The corpus has no answer | May answer from the model's own knowledge instead | Explicitly refuses |
| Source of the answer | A text description | Every citation resolves to a stored chunk and its source version |

**1. The model produces a request, not a side effect.** Tool calls for refunds and cancellations first stop at approval; the approval record is stored on the server, bound to the conversation, and can be consumed only once. Tool Dispatch performs the submission after approval and writes the result to the side-effect ledger.

**2. The idempotency key describes a business operation, not a single call.** The key is derived from the operation kind, the order, and the normalized line items, and excludes the retry count and call identifiers, so concurrent or repeated submissions converge into the same operation. When a response is lost after submission, the system admits it "does not know" instead of guessing an outcome.

**3. Answers must trace back to the corpus.** Candidate chunks must still pass the evidence threshold after rerank, and every citation is bound to a stored chunk and its source version; if no chunk meets the threshold, the system explicitly refuses.

## Architecture

- **Frontend:** handles the entry points, streaming, and card rendering, and holds no model, tool, or database credentials.
- **BFF:** the only external boundary: verifies identity, rate limits, propagates timeouts and cancellation, and rejects client writes to conversation state.
- **LangGraph Runtime:** hosts the five Graphs; the entry point decides which Graph is used, so no extra model routing is needed.
- **Tool Registry:** dispatches all tools through a single path; tools that change external state first go through human approval and write to the ledger after submission.

The diagram below shows which layers a Chat Gun request passes through from the frontend to the model Provider, where tools and side effects converge, and where observability is attached.

```mermaid
flowchart LR
  B["Frontend"]
  F["Frontend<br/>Vite + React 19"]
  G["BFF<br/>Auth · CORS · Rate limiting · Timeouts · State write guard"]
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
  TR["Tool Registry<br/>Unified Tool Dispatch"]
  NT["Native tools"]
  KB["kb_search"]
  OD["Order tools<br/>External state changes"]
  MT["MCP servers"]
  EM["Embedding · Rerank"]
  KS["Knowledge base<br/>PostgreSQL + pgvector"]
  HI["Human approval<br/>Persistable"]
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

| Directory | Purpose | Local default port |
| --- | --- | ---: |
| `frontend/` | Entry home page, Chat UI, streaming states, tool results, product and approval cards, image input | `5173` |
| `bff/` | API gateway, validation, proxying, timeouts, rate limiting, and state write guard | `8787` |
| `backend/` | LangGraph agents, model integration, Tools, knowledge base, and MCP | `2024` |

For how entry points map to Graphs, see [Entry Points and Agents](./docs/gun-shop.md#入口與-agents) (Traditional Chinese).

## Evaluation

**Retrieval quality (platform capability):**
- Dataset `kb-eval-v1` (40 questions, including refusal questions), corpus `kb-v1` (synthetic), Embedding `text-embedding-v4` (1024 dimensions), Rerank `qwen3-rerank`, answer generation `qwen-plus`.

Only the **test split** is listed below

| Configuration | Recall@5 | MRR | Citation accuracy | Correct refusal rate | False refusal rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| `vector_only` | 0.863 | 0.796 | 1.000 | 1.000 | 0.300 |
| `vector_rerank` | 1.000 | 0.917 | 1.000 | 1.000 | 0.100 |

**Flow evaluation (business implementation):**
- Deterministic test 10 / 10; live intent routing accuracy 1.000 (18 turns, `qwen3.7-plus`), prohibited outcomes 0.
- Dataset `chain-eval-v1` (15 questions), order data `synthetic-orders-v1` (synthetic), prompts `shopping-intent-v1` / `shopping-policy-answer-v1`.

**Known limitation:** the live test split passes 3 / 10; the remaining 7 questions share the same symptom (order operations return an empty result) and have not been fixed yet. The same set of cases all pass at the deterministic layer.

For full results, run counts, the dev split, latency, metric definitions, why faithfulness is not published, methodology, and how to rerun, see [Evaluation](./docs/evaluation.md) (Traditional Chinese).

## Security and Limitations

**Tools run in-process:** OS-level sandboxing has not shipped yet; tools declared to run in a separate process are explicitly rejected at registration or dispatch time and do not fall back to in-process execution. Read the [security settings](./docs/tool-security-isolation.md) (Traditional Chinese) before connecting MCP.

**Scope:**

- The corpus and order data are synthetic and do not represent real products or operating rules.
- The order tools are simulated, with no real transactions, payments, or external vendor integrations.
- Undo is not provided; an operation can only be cancelled before its side effect takes place.
- Evaluation is offline regression; the numbers reflect method effectiveness on controlled synthetic datasets, not production performance.

For the operation history projection, automatic reconciliation, and model selection mechanisms that are not yet implemented, see [Scope and Limitations](./docs/scope-and-limitations.md) (Traditional Chinese).

## Documentation Guide

| I want to… | Start here |
| --- | --- |
| Run it locally and run the tests | [Quick Start](./docs/getting-started.md) (Traditional Chinese) |
| Configure models, the knowledge base, BFF, and Frontend | [Configuration](./docs/configuration.md) (Traditional Chinese) |
| See the Gun Shop flow walkthrough and operation states | [Gun Shop](./docs/gun-shop.md) (Traditional Chinese) |
| Understand the retrieval pipeline, chunking, thresholds, and resumable ingestion | [Knowledge Base Retrieval](./docs/retrieval.md) (Traditional Chinese) |
| See full evaluation data or rerun the evaluation | [Evaluation](./docs/evaluation.md) (Traditional Chinese) |
| Understand the request flow, State, and checkpoints | [Runtime Architecture](./docs/architecture.md) (Traditional Chinese) · [TypeScript + LangGraph](./docs/typescript-langgraph-architecture.md) (Traditional Chinese) |
| Check trusted identity, rate limiting, and state protection | [BFF](./docs/bff.md) (Traditional Chinese) |
| Add a tool or connect MCP | [Tools and MCP](./docs/tools-and-mcp.md) (Traditional Chinese) · [Security Settings](./docs/tool-security-isolation.md) (Traditional Chinese) |
| Connect OpenTelemetry or Opik | [Observability](./docs/observability.md) (Traditional Chinese) |
| Troubleshoot common errors | [Troubleshooting](./docs/troubleshooting.md) (Traditional Chinese) |
| See the full list of limitations | [Scope and Limitations](./docs/scope-and-limitations.md) (Traditional Chinese) |

## License

Apache License 2.0. See [LICENSE](./LICENSE).
