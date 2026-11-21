# backend-model-runtime Specification

## Purpose
TBD - created by archiving change replace-gemini-runtime-with-qwen-bailian-runtime. Update Purpose after archive.
## Requirements
### Requirement: Qwen Provider Selection
Backend Runtime MUST support `LLM_PROVIDER=qwen` as a first-class provider and MUST report provider diagnostics as `qwen` when selected.

#### Scenario: Explicit Qwen provider is selected
- **GIVEN** runtime configuration contains `LLM_PROVIDER=qwen`
- **WHEN** Backend creates an LLM gateway
- **THEN** the selected provider MUST be `qwen`
- **AND** diagnostics MUST identify the endpoint kind as OpenAI-compatible Chat Completions
- **AND** missing Gemini credentials MUST NOT prevent Qwen gateway creation

#### Scenario: Existing providers remain selectable
- **GIVEN** runtime configuration selects `ccr` or `openai-compatible`
- **WHEN** Backend creates an LLM gateway
- **THEN** the selected provider MUST preserve the existing provider semantics
- **AND** Qwen environment variables MUST NOT override the explicit non-Qwen provider

### Requirement: Qwen Environment Variables
Backend Runtime MUST support Qwen-specific environment variables for base URL, API key, and purpose-specific models while preserving existing aliases.

#### Scenario: Qwen environment variables configure the request
- **GIVEN** `LLM_PROVIDER=qwen`
- **AND** `QWEN_BASE_URL`, `QWEN_API_KEY`, and `QWEN_CHAT_MODEL` are configured
- **WHEN** Backend invokes a chat model for chat purpose
- **THEN** the request MUST use the configured Qwen base URL
- **AND** the request MUST use the configured Qwen model
- **AND** the request MUST send the API key only as an authorization credential

#### Scenario: Existing aliases remain compatible
- **GIVEN** Backend is configured with `OPENAI_COMPATIBLE_*`, `OPENAI_*`, or `CCR_*` aliases
- **WHEN** Backend selects the corresponding existing provider
- **THEN** the aliases MUST continue to configure base URL, API key, provider, and model as before

### Requirement: OpenAI-Compatible Chat Completions
Qwen Runtime MUST use the OpenAI-compatible Chat Completions request and response contract.

#### Scenario: Chat Completions endpoint is built correctly
- **GIVEN** a Qwen or OpenAI-compatible base URL ending with or without a slash
- **WHEN** Backend invokes the provider
- **THEN** the final endpoint MUST be exactly one `/chat/completions` suffix after the compatible API base path

#### Scenario: Text response is parsed
- **GIVEN** the provider returns a successful Chat Completions response with `choices[0].message.content`
- **WHEN** Backend parses the response
- **THEN** Backend MUST return a LangChain AI message containing the provider content
- **AND** Backend MUST preserve available model, finish reason, usage, and response metadata

### Requirement: Capability-Aware Model Resolution
Backend Runtime MUST resolve models by provider and model purpose without relying on model-name substring checks to change domain behavior.

#### Scenario: Qwen purpose-specific model is resolved
- **GIVEN** `LLM_PROVIDER=qwen`
- **AND** purpose-specific Qwen model variables are configured
- **WHEN** Backend creates models for chat, math, research, vision, or tool purposes
- **THEN** each model MUST use the matching Qwen purpose-specific variable
- **AND** configured legacy model overrides MUST remain backward compatible

### Requirement: Provider Capability Enforcement
Backend Runtime MUST enforce provider capabilities before sending requests that require unsupported model features.

#### Scenario: Tool calling capability is unsupported
- **GIVEN** a selected provider reports `supportsToolCalling: false`
- **WHEN** Backend attempts to bind tools for that provider
- **THEN** Backend MUST fail fast with a structured capability error
- **AND** Backend MUST NOT silently skip tools or continue into a degraded tool-calling path

#### Scenario: Structured output capability is unsupported
- **GIVEN** a selected provider reports `supportsStructuredOutput: false`
- **WHEN** Backend creates or invokes a chat model with `responseFormat: { "type": "json_object" }`
- **THEN** Backend MUST fail fast with a structured capability error
- **AND** Backend MUST NOT silently omit the response format requirement

#### Scenario: Supported capabilities continue normally
- **GIVEN** a selected provider reports support for tool calling or structured output
- **WHEN** Backend binds tools or requests JSON object response format
- **THEN** Backend MUST preserve the provider request behavior for the supported capability

#### Scenario: Capability errors are safe
- **WHEN** Backend reports a provider capability error
- **THEN** the error message MUST identify the provider and missing capability
- **AND** the error MUST NOT include API keys, authorization headers, tokens, or credentials

### Requirement: JSON Mode Response Format
Backend Runtime MUST support JSON-only model calls through Chat Completions `response_format`.

#### Scenario: Planner uses JSON object response format
- **GIVEN** a planner, weather extraction, or repair call requires JSON-only output
- **WHEN** Backend invokes a Qwen-capable Chat Completions model
- **THEN** the request body MUST include `response_format: { "type": "json_object" }`
- **AND** the returned JSON MUST still pass Runtime Validation before use

#### Scenario: Invalid JSON is reported safely
- **GIVEN** the provider returns malformed JSON where JSON is required
- **WHEN** Backend parses the provider response
- **THEN** Backend MUST return or throw a structured parse error
- **AND** the error details MUST NOT include API keys, authorization headers, or full sensitive response bodies

### Requirement: Vision Model Routing
Backend Runtime MUST route image analysis requests to a vision-capable model and preserve existing image safety constraints. 圖片辨識請求的模型 MUST 由 vision 用途的設定解析（vision 專屬設定 → legacy 設定 → 預設生成模型），MUST NOT 採用使用者在 frontend 模型選單選擇、經 `reasoning_model` 送入的模型。

#### Scenario: Qwen vision model receives image content parts
- **GIVEN** a validated user message contains `image_url` content parts, including data URLs
- **AND** `LLM_PROVIDER=qwen`
- **WHEN** Backend performs image analysis
- **THEN** Backend MUST use the Qwen vision model for vision purpose
- **AND** the Chat Completions request MUST preserve supported text and image content parts

#### Scenario: 使用者選擇的模型不影響圖片辨識
- **GIVEN** 深度研究 run 的 `reasoning_model` 為 `qwen-plus`
- **AND** vision 專屬設定與 legacy 設定都未設定
- **AND** 使用者訊息包含一張有效圖片
- **WHEN** Backend 執行圖片辨識
- **THEN** 圖片辨識請求的模型 MUST 為預設生成模型 `qwen3.5-flash`
- **AND** 圖片辨識請求 MUST 包含該圖片的 `image_url` content part

#### Scenario: vision 專屬設定優先於預設模型
- **GIVEN** vision 專屬設定為 `qwen-vl-plus`
- **AND** 深度研究 run 的 `reasoning_model` 為 `qwen-max`
- **WHEN** Backend 執行圖片辨識
- **THEN** 圖片辨識請求的模型 MUST 為 `qwen-vl-plus`

#### Scenario: Vision is unsupported
- **GIVEN** the selected provider or model purpose does not support vision
- **WHEN** Backend receives an image analysis request
- **THEN** Backend MUST return a structured provider capability error or explicit degradation
- **AND** Backend MUST NOT silently report success

#### Scenario: 圖片辨識逾時
- **GIVEN** vision 模型請求超過 Gateway 逾時設定
- **WHEN** Backend 執行圖片辨識
- **THEN** Backend MUST 回報明確降級並保留逾時錯誤碼
- **AND** Backend MUST NOT 將逾時視為成功或產生圖片觀察內容

#### Scenario: 圖片辨識被取消
- **GIVEN** run 在圖片辨識進行中被取消
- **WHEN** vision 模型請求因取消而中止
- **THEN** Backend MUST 將取消向上傳遞為 run 取消
- **AND** Backend MUST NOT 將取消轉成降級結果或繼續後續節點

### Requirement: Tool Calling and bindTools
Qwen Runtime MUST support LangChain-style `bindTools` over OpenAI-compatible Chat Completions.

#### Scenario: Tools are sent to provider
- **GIVEN** Backend binds structured tools to a Qwen-capable model
- **WHEN** the model is invoked
- **THEN** the request body MUST include OpenAI-compatible `tools`
- **AND** each tool MUST be represented as a function with name, description, and JSON Schema parameters
- **AND** `tool_choice` MUST default to `auto` unless a compatible option overrides it

#### Scenario: Provider tool calls become LangChain tool calls
- **GIVEN** the provider returns `choices[0].message.tool_calls`
- **WHEN** Backend parses the response
- **THEN** Backend MUST create a LangChain AI message with `tool_calls`
- **AND** each tool call MUST preserve id, name, parsed args, and `type: "tool_call"`

### Requirement: ToolMessage Round Trip
Backend Runtime MUST preserve tool call ids and tool result messages across model turns.

#### Scenario: Tool result is sent to next model turn
- **GIVEN** a model emits a tool call
- **AND** Backend executes the tool and receives a ToolMessage
- **WHEN** Backend sends the next request to Qwen Chat Completions
- **THEN** the previous assistant tool call id MUST be preserved
- **AND** the ToolMessage MUST be serialized with the matching `tool_call_id`
- **AND** the model MUST be able to emit a final assistant answer after receiving the tool result

### Requirement: MCP Agent Remains Backend-Executed
MCP Agent MUST continue to execute MCP through Backend MCP Client, ToolRegistry, ToolNode, and model `bindTools`; it MUST NOT delegate MCP execution to Bailian-hosted Responses API tools.

#### Scenario: MCP Agent works with Qwen provider
- **GIVEN** Backend loads local or MCP tools through ToolRegistry
- **AND** `LLM_PROVIDER=qwen`
- **WHEN** MCP Agent binds tools and invokes the model
- **THEN** it MUST NOT fail because the selected model lacks `bindTools`
- **AND** ToolNode MUST remain responsible for executing tool calls

#### Scenario: MCP tool governance remains active
- **GIVEN** MCP tools are loaded
- **WHEN** Backend exposes them to the model through `bindTools`
- **THEN** existing Backend tool governance, allowlist, audit, and tool execution boundaries MUST remain in effect

### Requirement: Provider-Specific Error Mapping
Backend Runtime MUST map provider failures to structured error codes without relying on natural-language text matching as the primary classifier.

#### Scenario: HTTP provider errors are categorized
- **GIVEN** Qwen or OpenAI-compatible provider returns HTTP 401, 403, 429, 400, or 5xx
- **WHEN** Backend creates an error envelope
- **THEN** the error code MUST distinguish auth, quota/rate limit, bad request, and provider server error categories
- **AND** provider metadata MUST identify the selected provider

#### Scenario: Transport, timeout, abort, and parse errors are handled safely
- **GIVEN** provider invocation fails due to transport failure, timeout/abort, or invalid JSON
- **WHEN** Backend creates an error envelope
- **THEN** the error code MUST distinguish timeout and provider response parse errors when structured sources identify them
- **AND** unmanaged transport cause codes MUST fall back to `unknown_error` with safe telemetry details
- **AND** error details MUST NOT leak credentials

### Requirement: Error Code Source MUST Be Structured
Backend Runtime MUST determine public error codes from structured sources and MUST NOT use error message regex matching as the public classifier.

#### Scenario: Structured sources produce public error codes
- **GIVEN** Backend receives an error with structured status, name, or allowlisted cause code
- **WHEN** Backend infers the public error code
- **THEN** Backend MUST derive the code from the structured source
- **AND** message text such as `timeout`, `network`, `fetch failed`, `connect`, or `aborted` MUST NOT be the primary public classifier

#### Scenario: Unknown structured source falls back safely
- **GIVEN** Backend receives an unmanaged or unknown structured cause code
- **WHEN** Backend infers the public error code
- **THEN** Backend MUST return `unknown_error`
- **AND** Backend MAY retain the original cause code only in safe telemetry details

#### Scenario: Existing public error codes remain stable
- **GIVEN** Backend recognizes a stable public error code such as `provider_auth_error`, `quota_or_rate_limit_exceeded`, `provider_unavailable`, `provider_http_error`, `provider_request_validation_error`, `llm_response_json_parse_failed`, or `timeout`
- **WHEN** Backend reports an error envelope
- **THEN** Backend MUST preserve that public code
- **AND** Backend MUST NOT invent provider- or runtime-specific public codes from raw messages

### Requirement: Usage and Model Metadata Normalization
Backend Runtime MUST normalize available provider usage and model metadata while tolerating unknown provider fields.

#### Scenario: Usage metadata is available
- **GIVEN** the provider returns usage and model metadata
- **WHEN** Backend creates the AI message
- **THEN** token usage MUST be exposed through LangChain-compatible usage metadata when possible
- **AND** provider model, finish reason, endpoint kind, and response id MUST be preserved in response metadata when available

#### Scenario: Usage metadata is missing
- **GIVEN** the provider response omits usage metadata
- **WHEN** Backend creates the AI message
- **THEN** the message MUST still be usable
- **AND** missing usage fields MUST NOT be treated as provider failure

### Requirement: Credential Safety
Backend Runtime and OpenSpec artifacts MUST NOT contain real API keys, tokens, or credentials.

#### Scenario: Credential is configured by environment
- **GIVEN** Qwen or other provider credentials are needed
- **WHEN** Backend runtime starts
- **THEN** credentials MUST be read from environment or provider auth flow
- **AND** repository files, tests, OpenSpec, and example files MUST NOT contain real credentials

#### Scenario: Credential appears in provider failure
- **GIVEN** a provider failure includes credential-shaped data in a response or thrown error
- **WHEN** Backend reports diagnostics
- **THEN** diagnostics MUST redact or omit credential-shaped data

### Requirement: Live Smoke Verification Is Explicit
Backend Runtime MUST distinguish automated mock verification from live Qwen／Bailian smoke verification.

#### Scenario: Live smoke is not run
- **GIVEN** no real `QWEN_API_KEY` or approved live test is available
- **WHEN** the change is reported
- **THEN** the report MUST state that live Qwen／Bailian smoke was not verified
- **AND** mock tests MUST NOT be described as live production validation

### Requirement: Qwen Is The Default Runtime Provider
Backend model runtime MUST default to Qwen/Bailian when no explicit supported provider is configured.

#### Scenario: No provider is configured
- **WHEN** backend model runtime resolves the provider without `LLM_PROVIDER`
- **THEN** the selected provider MUST be `qwen`
- **AND** diagnostics MUST identify the endpoint kind as OpenAI-compatible Chat Completions

#### Scenario: Qwen provider remains selectable
- **GIVEN** runtime configuration contains `LLM_PROVIDER=qwen`
- **WHEN** backend creates an LLM gateway
- **THEN** the selected provider MUST be `qwen`
- **AND** missing `GEMINI_API_KEY` MUST NOT affect gateway creation

### Requirement: Gemini Runtime Provider Removed
Backend model runtime MUST NOT expose Gemini as a selectable provider and MUST NOT construct Gemini SDK chat models.

#### Scenario: Gemini provider is requested
- **GIVEN** runtime configuration contains `LLM_PROVIDER=gemini`
- **WHEN** backend resolves the LLM provider
- **THEN** backend MUST fail fast with an unsupported provider error
- **AND** backend MUST NOT fall back to Gemini

#### Scenario: Gemini dependency is absent
- **WHEN** backend dependencies are installed
- **THEN** `@langchain/google-genai` MUST NOT be present as a backend dependency
- **AND** backend runtime code MUST NOT import `@langchain/google-genai`

### Requirement: Existing Non-Gemini Providers Remain Available
Backend model runtime MUST preserve Qwen, CCR, and generic OpenAI-compatible provider behavior after Gemini removal.

#### Scenario: CCR provider remains selectable
- **GIVEN** runtime configuration contains `LLM_PROVIDER=ccr`
- **WHEN** backend creates an LLM gateway
- **THEN** the selected provider MUST be `ccr`
- **AND** the endpoint kind MUST remain Anthropic messages

#### Scenario: OpenAI-compatible provider remains selectable
- **GIVEN** runtime configuration contains `LLM_PROVIDER=openai-compatible`
- **WHEN** backend creates an LLM gateway
- **THEN** the selected provider MUST be `openai-compatible`
- **AND** the endpoint kind MUST remain OpenAI-compatible Chat Completions

### Requirement: No Gemini Runtime Code Path
Backend source runtime paths MUST NOT contain Gemini-specific provider code after the removal.

#### Scenario: Backend source is searched
- **WHEN** backend source files are searched for Gemini provider identifiers
- **THEN** no backend runtime source file MUST contain Gemini-specific imports, provider enum values, endpoint kinds, fallback models, or credential checks

### Requirement: Public API And MCP Compatibility
Gemini removal MUST NOT change frontend/bff public APIs, LangGraph Graph IDs, MCP execution architecture, or tool governance.

#### Scenario: Runtime provider is removed
- **WHEN** Gemini provider code is removed
- **THEN** existing Graph IDs MUST remain unchanged
- **AND** BFF routes and frontend request shape MUST remain unchanged
- **AND** MCP tools MUST still execute through backend ToolRegistry and ToolNode
