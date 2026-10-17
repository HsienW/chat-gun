# Chat Gun

<p align="center">
  <img src="./assets/chat-gun-logo.jpg" alt="chat-gun" width="1024" />
</p>

[![License](https://img.shields.io/badge/License-Apache%202.0-22C55E)](./LICENSE)
[![LangGraph](https://img.shields.io/badge/LangGraph-JS-06B6D4)](https://langchain-ai.github.io/langgraphjs/)
[![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-Observability-8A7600)](https://opentelemetry.io/)
[![MCP](https://img.shields.io/badge/MCP-Protocol-111827)](https://modelcontextprotocol.io/)
[![Qwen](https://img.shields.io/badge/Qwen-Model_Provider-1E3A8A)](https://github.com/QwenLM/Qwen)
[![Tavily](https://img.shields.io/badge/Tavily-Search_API-BE185D)](https://docs.tavily.com/documentation/api-reference/endpoint/search)
[![Brave Search](https://img.shields.io/badge/Brave_Search-MCP-FB542B)](https://brave.com/search/api/)
[![Opik](https://img.shields.io/badge/Opik-Tracing_%26_Evaluation-6F4CFF)](https://github.com/comet-ml/opik)
[![Origins](https://img.shields.io/badge/Project_Origins-Ylang_Labs-F97316)](https://github.com/Ylang-Labs/langgraph-react-agent-studio)

<p align="center">
  <a href="./README.en.md">English</a> |
  <a href="./README.md">繁體中文</a> |
  <a href="./README.zh-CN.md">简体中文</a>
</p>

Chat Gun 是一套以 React、TypeScript 与 LangGraph JS 构建的全栈 Agent Chat 应用。它支持多 Agent 对话、串流回复、Tool Calling、图片输入与 Human-in-the-Loop，并通过 BFF 统一处理浏览器与 LangGraph Runtime 之间的 API 流量。

## 核心功能

- **Agent-workflows**：
  - Deep Researcher 负责多步骤研究与引用验证。
  - Chat Assistant 处理一般对话。
  - Math Solver 执行算式与数值运算。
  - MCP Agent 则通过 Tool Calling 使用 native 与 MCP tools。
- **Streaming**：即时串流回答与执行活动，并支持 Cancellation 与 Exception handling，让使用者能中止进行中的请求并看见明确的错误状态。
- **HITL**：天气地点不明确时，Agent 会列出候选地点向使用者确认，再接续原本的 thread 执行。
- **Multimodal input**：接受 PNG、JPEG 与 WebP 图片，通过 vision model 分析内容并纳入回答或研究流程。
- **Native Tools**：内建计算、由 Tavily Search API 提供的网络搜索、网页撷取、目前天气与天气预报工具，Agent 可依问题选择合适工具。
- **MCP integration**：可选择载入 Filesystem 与 Brave Search MCP Server；Brave Search 以选配 MCP Tool 的形式扩充搜索能力。
- **Agent／Tool SDK**：提供具备类型的 Agent 与 Tool 声明方式，并以版本化 manifest 描述输入输出、所需权限与执行条件。
- **Model providers**：支持 Qwen、OpenAI-compatible 与 CCR-compatible endpoints，统一由 LLM Gateway 处理模型能力与呼叫接口。
- **API Gateway**：BFF 集中处理 API key authentication、CORS、request size validation、Timeout、Cancellation propagation 与 Rate limiting。
- **Observability & Evaluation**：提供 Metrics 与 OpenTelemetry，并可启用 Opik tracing、versioned datasets 与 experiments 来追踪及评估 Agent 行为。

> 📌
> 默认仅适用于本机开发。公开部署前，请启用 Authentication、设定明确的 CORS allowlist、妥善管理 Secrets 与数据库凭证，并依部署架构配置共享 Rate limiting、TLS 与 Reverse Proxy。若需要跨重启或多实例恢复 Agent 执行，请改用 durable checkpointer。

## Demo

<p align="center">
  <img src="./assets/chat-gun-demo.webp" alt="Chat Gun demo" width="1280" />
</p>

<p align="center">
  <img src="./assets/chat-gun-01.png" alt="Chat home screen" width="1280" />
</p>

<p align="center">
  <img src="./assets/chat-gun-02.png" alt="Agent response and activity" width="1280" />
</p>

<p align="center">
  <img src="./assets/chat-gun-03.png" alt="Tool-assisted agent result" width="1280" />
</p>

## 架构

```text
Browser
  -> frontend: Vite + React 19 + TypeScript
  -> bff: Node.js + TypeScript
  -> backend: LangGraph JS + LangChain
  -> Model Provider / Native Tools / MCP Tools
```

| 目录 | 用途 | 本机预设 port |
| --- | --- | ---: |
| `frontend/` | Chat UI、串流状态、工具结果与图片输入 | `5173` |
| `bff/` | API gateway、验证、代理、逾时与限流 | `8787` |
| `backend/` | LangGraph agents、模型整合、Tools 与 MCP | `2024` |

本机开发时，Frontend 会把 `/api/*` 代理至 BFF；LangGraph 请求经由 `/api/langgraph/*` 转送到 Backend。模型、Tool 与 MCP credential 只保留在 Server 端。

```text
http://localhost:5173/app/
  -> http://127.0.0.1:8787/api/langgraph/*
  -> http://localhost:2024
```

## Agents

| Graph ID | 名称 | 用途 |
| --- | --- | --- |
| `deep_researcher` | Deep Researcher | 深度研究、来源整理、工具调用、天气查询与图片理解 |
| `chatbot` | Chat Assistant | 一般对话 |
| `math_agent` | Math Solver | 数学问题与运算 |
| `mcp_agent` | MCP Agent | 使用已启用的 native／MCP tools |

Frontend 提供 `qwen-plus`、`qwen-max` 与 `qwen-turbo`，预设选用 `qwen-plus`。Backend 可针对不同 Agent 指定模型。

## 系统需求

- Node >= 22
- npm >= 10.8.x
- Qwen API key，或可用的 OpenAI-compatible／CCR-compatible endpoint
- Tavily Search API key（使用内建 `web_search` 时需要）
- Brave Search API key（启用 Brave Search MCP Server 时需要，选用）
- Docker 与 Docker Compose（选用）

## 安装

```bash
git clone https://github.com/HsienW/chat-gun.git
cd chat-gun

cd backend && npm ci
cd ../bff && npm ci
cd ../frontend && npm ci
cd ..
```

PowerShell：

```powershell
git clone https://github.com/HsienW/chat-gun.git
Set-Location chat-gun

Set-Location backend
npm ci
Set-Location ..\bff
npm ci
Set-Location ..\frontend
npm ci
Set-Location ..
```

## 设定

### Backend

从范例建立本机设定：

```bash
cp backend/.env.example backend/.env
```

PowerShell：

```powershell
Copy-Item backend/.env.example backend/.env
```

使用 Qwen 时，至少填入：

```env
LLM_PROVIDER=qwen
QWEN_API_KEY=your_qwen_api_key
```

Deep Researcher 的内建 `web_search` 使用 Tavily Search API：

```env
TAVILY_API_KEY=your_tavily_api_key
```

也可以连接其他模型端点：

```env
# OpenAI-compatible
LLM_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=https://your-endpoint.example/v1
OPENAI_COMPATIBLE_API_KEY=your_api_key
OPENAI_COMPATIBLE_MODEL=your_model

# CCR-compatible
LLM_PROVIDER=ccr
CCR_BASE_URL=http://127.0.0.1:3456/v1
CCR_API_KEY=your_api_key
CCR_MODEL=your_model
```

其他模型、图片、天气、Tool 与 MCP 设定请参阅 [`backend/.env.example`](./backend/.env.example)。不要将 API key 或其他 credential 提交到版本控制。

### BFF

```bash
cp bff/.env.example bff/.env
```

PowerShell：

```powershell
Copy-Item bff/.env.example bff/.env
```

| 环境变量 | 用途 |
| --- | --- |
| `BFF_LANGGRAPH_API_URL` | LangGraph API URL |
| `BFF_ALLOWED_ORIGINS` | 允许存取 BFF 的浏览器 origins |
| `BFF_REQUIRE_AUTH` | 是否要求 API key 或 Bearer token |
| `BFF_API_KEYS` | 允许使用的 API keys |
| `BFF_MAX_BODY_BYTES` | Request body 上限 |
| `BFF_UPSTREAM_TIMEOUT_MS` | Upstream request timeout |
| `BFF_RATE_LIMIT_REDIS_URI` | Redis rate limiter；留空时使用 in-memory limiter |

完整选项请参阅 [`bff/.env.example`](./bff/.env.example)。

### Frontend

本机开发不需要建立 `frontend/.env`。Frontend 预设使用同源 `/api/langgraph`；分开部署时可指定 BFF URL：

```env
VITE_LANGGRAPH_API_URL=https://api.example.com/api/langgraph
```

图片输入限制请参阅 [`frontend/.env.example`](./frontend/.env.example)。`VITE_*` 会出现在浏览器 bundle，不能用来保存 secret。

## 本机开发

分别启动 Backend、BFF 与 Frontend。

```bash
# Terminal 1
cd backend
npm run dev
```

```bash
# Terminal 2
cd bff
npm run dev
```

```bash
# Terminal 3
cd frontend
npm run dev
```

开启 <http://localhost:5173/app/>。

可使用 BFF 的健康检查确认服务状态：

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/ready
```

PowerShell：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
Invoke-RestMethod http://127.0.0.1:8787/api/ready
```

`/api/ready` 会检查 BFF 是否能连上 LangGraph Backend。

## Tools

| Tool | 用途 | 必要设定 |
| --- | --- | --- |
| `calculator_tool` | 算术运算 | 无 |
| `web_search` | Tavily Search API | `TAVILY_API_KEY` |
| `web_fetch` | HTTP／HTTPS 网页撷取 | 无 |
| `current_weather` | Open-Meteo 目前天气 | 无 |
| `weather_forecast` | Open-Meteo 天气预报 | 无 |

可以使用 `TOOL_ALLOWLIST`、`TOOL_DENYLIST`、`TOOL_TIMEOUT_MS` 与个别 Tool 设定限制可用范围。`web_fetch` 预设只允许 port `80`、`443`，并拒绝不安全的 private network address。

### 扩展 Agent 与 Tool

- TypeScript 开发者可以使用以下软件包：
  - [`@gun-ai/harness-sdk`](https://www.npmjs.com/package/@gun-ai/harness-sdk) 的 `defineAgent`、`defineTool`
    - 声明 Agent 与 Tool，并通过版本化 manifest 指定数据格式、所需权限、执行环境与重试等条件。
    - 注册时会验证声明；不完整或相互矛盾的设定会被拒绝。

  - [`@gun-ai/harness-testkit`](https://www.npmjs.com/package/@gun-ai/harness-testkit)
    - 提供测试辅助工具。本项目使用 alpha 版本，扩展时请固定兼容版本。

- 要在 Chat Gun 使用自定义 Tool，仍需在 Backend 接入实现并设定授权与执行环境；安装 SDK 不会自动启用 Tool，也不会绕过现有的安全检查。

## MCP

MCP tools 预设不会在启动时载入。启用 Filesystem MCP：

```env
MCP_LOAD_ON_START=true
MCP_FILESYSTEM_ENABLED=true
MCP_FILESYSTEM_PATH=/absolute/path/to/workspace
MCP_FILESYSTEM_ALLOWED_ROOTS=/absolute/path/to/workspace
```

让 Deep Researcher 使用 MCP tools：

```env
DEEP_RESEARCHER_MCP_ENABLED=true
```

启用选配的 Brave Search MCP Server：

```env
MCP_BRAVE_SEARCH_ENABLED=true
BRAVE_API_KEY=your_brave_api_key
```

`MCP_FILESYSTEM_PATH` 必须位于 `MCP_FILESYSTEM_ALLOWED_ROOTS` 内。多个 root 在 Windows 使用 `;` 分隔，在 Linux／macOS 使用 `:`。

## Observability

BFF 提供 metrics endpoint：

```bash
curl http://127.0.0.1:8787/api/metrics
```

OpenTelemetry 预设关闭。连接 OTLP collector：

```env
OTEL_ENABLED=true
OTEL_SERVICE_NAME=chat-gun
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http
OTEL_SAMPLE_RATE=1
```

Opik 可用于开发期间的 Agent tracing 与 Weather evaluation。它预设关闭；启用 hosted tracing 时应使用非正式环境数据，并保持 redaction 开启。

```env
OPIK_ENABLED=true
OPIK_API_KEY=your_opik_api_key
OPIK_WORKSPACE=your_workspace
OPIK_REDACT_ENABLED=true
```

执行 evaluation：

```bash
cd backend
npm run eval:opik
```

## Docker Compose

Docker Compose 会启动 PostgreSQL、Redis、LangGraph API 与 BFF，并由 BFF 提供构建后的 Frontend。

在专案根目录建立 `.env`：

```env
QWEN_API_KEY=your_qwen_api_key
TAVILY_API_KEY=your_tavily_api_key
```

启动服务：

```bash
docker compose up --build
```

开启 <http://localhost:8123/app/>。

Compose 预设使用 Qwen。改用其他 provider 或启用额外 Backend 功能时，请把对应环境变量加入 `docker-compose.yml` 的 `langgraph-api.environment`。

## 测试

Backend：

```bash
cd backend
npm run lint
npm run test
npm run build
```

BFF：

```bash
cd bff
npm run test
npm run build
```

Frontend：

```bash
cd frontend
npm run lint
npm run test
npm run build
```

## 疑难排解

### Frontend 出现 `Invalid URL`

`VITE_LANGGRAPH_API_URL` 必须是完整 URL。若 Frontend 与 BFF 使用同一个 origin，移除这个设定即可。

```env
VITE_LANGGRAPH_API_URL=http://localhost:5173/api/langgraph
```

### `/api/langgraph/*` 回传 502

先确认 BFF 与 Backend 状态：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/ready
Invoke-RestMethod http://localhost:2024/ok
```

再检查 `BFF_LANGGRAPH_API_URL` 是否指向正在执行的 LangGraph API。

### `Research synthesis failed ... fetch failed`

确认模型或 Tool provider 的 API key、base URL 与网络连线。使用 Qwen／Alibaba Cloud Bailian 时，可以先测试：

```powershell
Test-NetConnection dashscope.aliyuncs.com -Port 443
```

需要 proxy 时，在 `backend/.env` 设定 `HTTPS_PROXY`、`HTTP_PROXY` 与 `NO_PROXY`，然后重新启动 Backend。

## 文件

- [BFF API Gateway](./docs/bff.md)
- [Agent 执行架构](./docs/architecture.md)
- [TypeScript + LangGraph 架构](./docs/typescript-langgraph-architecture.md)
- [Tool 与 MCP 安全设定](./docs/tool-security-isolation.md)

## License

Apache License 2.0。详见 [LICENSE](./LICENSE)。
