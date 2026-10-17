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

Chat Gun is a full-stack agent chat application built with React, TypeScript, and LangGraph JS. It supports multi-agent conversations, streamed responses, tool calling, image input, and human-in-the-loop workflows, with a BFF that manages API traffic between the browser and the LangGraph runtime.

## Core Features

- **Agent workflows**:
  - Deep Researcher performs multi-step research and source verification.
  - Chat Assistant handles general conversations.
  - Math Solver evaluates expressions and performs numerical calculations.
  - MCP Agent uses native and MCP tools through tool calling.
- **Streaming**: Streams answers and execution activity in real time, with cancellation and exception handling so users can stop active requests and see clear error states.
- **HITL**: When a weather location is ambiguous, the agent presents candidate locations for confirmation and then resumes the original thread.
- **Multimodal input**: Accepts PNG, JPEG, and WebP images and uses a vision model to incorporate their content into answers and research workflows.
- **Native Tools**: Includes calculation, web search powered by the Tavily Search API, web fetching, current weather, and weather forecast tools that agents can select as needed.
- **MCP integration**: Optionally loads Filesystem and Brave Search MCP Servers; Brave Search extends search capabilities as an optional MCP Tool.
- **Agent/Tool SDK**: Provides typed declarations for agents and tools, with versioned manifests describing inputs, outputs, required permissions, and execution requirements.
- **Model providers**: Supports Qwen, OpenAI-compatible, and CCR-compatible endpoints through a shared LLM Gateway interface.
- **API Gateway**: The BFF centralizes API key authentication, maps verified API keys to trusted principal contexts, and handles CORS, request size validation, timeouts, cancellation propagation, and rate limiting. When authentication is enabled, client-supplied identity and tenant headers are not treated as trusted identity sources.
- **Observability & Evaluation**: Provides metrics and OpenTelemetry, with optional Opik tracing, versioned datasets, and experiments for tracking and evaluating agent behavior.

> 📌
> The default configuration is intended for local development only. Before exposing the application publicly, enable authentication, define an explicit CORS allowlist, secure secrets and database credentials, and configure shared rate limiting, TLS, and a reverse proxy for your deployment architecture. Use a durable checkpointer if agent runs must survive restarts or continue across multiple instances.

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

## Architecture

```text
Browser
  -> frontend: Vite + React 19 + TypeScript
  -> bff: Node.js + TypeScript
  -> backend: LangGraph JS + TypeScript
  -> Model Provider / Native Tools / MCP Tools
```

| Directory | Purpose | Default local port |
| --- | --- | ---: |
| `frontend/` | Chat UI, streaming state, tool results, and image input | `5173` |
| `bff/` | API gateway, validation, proxying, timeouts, and rate limiting | `8787` |
| `backend/` | LangGraph agents, model integrations, tools, and MCP | `2024` |

During local development, the frontend proxies `/api/*` to the BFF, while LangGraph requests are forwarded to the backend through `/api/langgraph/*`. Model, tool, and MCP credentials remain on the server.

```text
http://localhost:5173/app/
  -> http://127.0.0.1:8787/api/langgraph/*
  -> http://localhost:2024
```

## Agents

| Graph ID | Name | Purpose |
| --- | --- | --- |
| `deep_researcher` | Deep Researcher | In-depth research, source organization, tool calling, weather queries, and image understanding |
| `chatbot` | Chat Assistant | General conversations |
| `math_agent` | Math Solver | Math questions and calculations |
| `mcp_agent` | MCP Agent | Uses enabled native and MCP tools |

The frontend offers `qwen-plus`, `qwen-max`, and `qwen-turbo`, with `qwen-plus` selected by default. The backend can assign different models to individual agents.

## Requirements

- Node >= 22
- npm >= 10.8.x
- A Qwen API key or an available OpenAI-compatible or CCR-compatible endpoint
- A Tavily Search API key for the built-in `web_search` tool
- A Brave Search API key when enabling the optional Brave Search MCP Server
- Docker and Docker Compose (optional)

## Installation

```bash
git clone https://github.com/HsienW/chat-gun.git
cd chat-gun

cd backend && npm ci
cd ../bff && npm ci
cd ../frontend && npm ci
cd ..
```

PowerShell:

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

## Configuration

### Backend

Create the local configuration from the example file:

```bash
cp backend/.env.example backend/.env
```

PowerShell:

```powershell
Copy-Item backend/.env.example backend/.env
```

When using Qwen, provide at least the following values:

```env
LLM_PROVIDER=qwen
QWEN_API_KEY=your_qwen_api_key
```

Deep Researcher's built-in `web_search` tool uses the Tavily Search API:

```env
TAVILY_API_KEY=your_tavily_api_key
```

You can also connect other model endpoints:

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

See [`backend/.env.example`](./backend/.env.example) for additional model, image, weather, tool, and MCP settings. Do not commit API keys or other credentials to version control.

### BFF

```bash
cp bff/.env.example bff/.env
```

PowerShell:

```powershell
Copy-Item bff/.env.example bff/.env
```

| Environment variable | Purpose |
| --- | --- |
| `BFF_LANGGRAPH_API_URL` | LangGraph API URL |
| `BFF_ALLOWED_ORIGINS` | Browser origins allowed to access the BFF |
| `BFF_REQUIRE_AUTH` | Whether an API key or Bearer token is required; trusted principal profiles are also required when enabled |
| `BFF_API_KEYS` | Usually left empty; when set, every key still needs a corresponding principal profile |
| `BFF_API_KEY_PRINCIPALS_JSON` | API-key-indexed principal profile JSON containing `principalId`, `principalType`, `tenantId`, `roles`, and `scopes` |
| `BFF_LEGACY_HEADER_MODE` | Whether to continue forwarding the compatibility `x-bff-user-id` header to the Backend; defaults to `true` |
| `BFF_MAX_BODY_BYTES` | Request body size limit |
| `BFF_UPSTREAM_TIMEOUT_MS` | Upstream request timeout |
| `BFF_RATE_LIMIT_REDIS_URI` | Redis rate limiter; uses the in-memory limiter when unset |

See [`bff/.env.example`](./bff/.env.example) for other BFF options.

When BFF authentication is enabled, every API key must have a trusted principal profile. Setting only `BFF_API_KEYS` returns `401` because trusted identity data is missing. The BFF ignores client-supplied `x-user-id` and `x-tenant-id` headers, derives the `x-bff-*` headers from the profile, and forwards them to the Backend. Resource-level authorization is enabled explicitly by each tool or workflow that requires it.

```env
BFF_REQUIRE_AUTH=true
BFF_API_KEY_PRINCIPALS_JSON={"replace-with-a-long-random-key":{"principalId":"local-user","principalType":"user","tenantId":"local","roles":[],"scopes":[]}}
```

The JSON key in `BFF_API_KEY_PRINCIPALS_JSON` is itself a credential. Provide it only through environment variables or a secret manager, and never commit it to version control.

### Frontend

Local development does not require a `frontend/.env` file. The frontend uses same-origin `/api/langgraph` by default. Set the BFF URL when deploying it separately:

```env
VITE_LANGGRAPH_API_URL=https://api.example.com/api/langgraph
```

See [`frontend/.env.example`](./frontend/.env.example) for image input limits. Values prefixed with `VITE_*` are included in the browser bundle and must not contain secrets.

## Local Development

Start the backend, BFF, and frontend in separate terminals.

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

Open <http://localhost:5173/app/>.

Use the BFF health endpoints to verify service status:

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/ready
```

PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
Invoke-RestMethod http://127.0.0.1:8787/api/ready
```

`/api/ready` checks whether the BFF can connect to the LangGraph backend.

## Tools

| Tool | Purpose | Required configuration |
| --- | --- | --- |
| `calculator_tool` | Arithmetic calculations | None |
| `web_search` | Tavily Search API | `TAVILY_API_KEY` |
| `web_fetch` | HTTP/HTTPS page fetching | None |
| `current_weather` | Current weather from Open-Meteo | None |
| `weather_forecast` | Weather forecasts from Open-Meteo | None |

Use `TOOL_ALLOWLIST`, `TOOL_DENYLIST`, `TOOL_TIMEOUT_MS`, and tool-specific settings to restrict the available capabilities. By default, `web_fetch` allows only ports `80` and `443` and blocks unsafe private network addresses.

### Extending Agents and Tools

- TypeScript developers can use these packages:
  - [`@gun-ai/harness-sdk`](https://www.npmjs.com/package/@gun-ai/harness-sdk) provides `defineAgent` and `defineTool`.
    - Declare agents and tools with versioned manifests that specify data schemas, required permissions, execution environments, retry behavior, and other requirements.
    - Declarations are validated during registration; incomplete or contradictory settings are rejected.

  - [`@gun-ai/harness-testkit`](https://www.npmjs.com/package/@gun-ai/harness-testkit)
    - Provides test helpers. This project uses alpha versions of these packages; pin compatible versions when extending it.

- To use a custom tool in Chat Gun, you must also integrate its implementation into the Backend and configure authorization and execution. Installing the SDK does not automatically enable tools or bypass existing security checks.

## MCP

MCP tools are not loaded at startup by default. Enable the Filesystem MCP Server with:

```env
MCP_LOAD_ON_START=true
MCP_FILESYSTEM_ENABLED=true
MCP_FILESYSTEM_PATH=/absolute/path/to/workspace
MCP_FILESYSTEM_ALLOWED_ROOTS=/absolute/path/to/workspace
```

Allow Deep Researcher to use MCP tools:

```env
DEEP_RESEARCHER_MCP_ENABLED=true
```

Enable the optional Brave Search MCP Server:

```env
MCP_BRAVE_SEARCH_ENABLED=true
BRAVE_API_KEY=your_brave_api_key
```

`MCP_FILESYSTEM_PATH` must be located within `MCP_FILESYSTEM_ALLOWED_ROOTS`. Separate multiple roots with `;` on Windows and `:` on Linux or macOS.

## Observability

The BFF exposes a metrics endpoint:

```bash
curl http://127.0.0.1:8787/api/metrics
```

OpenTelemetry is disabled by default. Connect an OTLP collector with:

```env
OTEL_ENABLED=true
OTEL_SERVICE_NAME=chat-gun
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http
OTEL_SAMPLE_RATE=1
```

Opik supports agent tracing and weather evaluation during development. It is disabled by default. When enabling hosted tracing, use non-production data and keep redaction enabled.

```env
OPIK_ENABLED=true
OPIK_API_KEY=your_opik_api_key
OPIK_WORKSPACE=your_workspace
OPIK_REDACT_ENABLED=true
```

Run the evaluation:

```bash
cd backend
npm run eval:opik
```

## Docker Compose

Docker Compose starts PostgreSQL, Redis, the LangGraph API, and the BFF. The BFF also serves the built frontend.

Create a `.env` file in the project root:

```env
QWEN_API_KEY=your_qwen_api_key
TAVILY_API_KEY=your_tavily_api_key
```

Start the services:

```bash
docker compose up --build
```

Open <http://localhost:8123/app/>.

Compose uses Qwen by default. To use another provider or enable additional backend features, add the corresponding environment variables to `langgraph-api.environment` in `docker-compose.yml`.

## Testing

Backend:

```bash
cd backend
npm run lint
npm run test
npm run build
```

BFF:

```bash
cd bff
npm run test
npm run build
```

Frontend:

```bash
cd frontend
npm run lint
npm run test
npm run build
```

## Troubleshooting

### Frontend shows `Invalid URL`

`VITE_LANGGRAPH_API_URL` must be a complete URL. Remove this setting when the frontend and BFF share the same origin.

```env
VITE_LANGGRAPH_API_URL=http://localhost:5173/api/langgraph
```

### `/api/langgraph/*` returns 502

First, check the BFF and backend status:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/ready
Invoke-RestMethod http://localhost:2024/ok
```

Then verify that `BFF_LANGGRAPH_API_URL` points to the running LangGraph API.

### `Research synthesis failed ... fetch failed`

Check the model or tool provider API key, base URL, and network connection. When using Qwen or Alibaba Cloud Bailian, you can test connectivity with:

```powershell
Test-NetConnection dashscope.aliyuncs.com -Port 443
```

If a proxy is required, configure `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` in `backend/.env`, then restart the backend.

## Documentation

- [BFF API Gateway](./docs/bff.en.md)
- [Agent Runtime Architecture](./docs/architecture.en.md)
- [TypeScript + LangGraph Architecture](./docs/typescript-langgraph-architecture.en.md)
- [Tool and MCP Security Configuration](./docs/tool-security-isolation.en.md)

## License

Apache License 2.0. See [LICENSE](./LICENSE) for details.
