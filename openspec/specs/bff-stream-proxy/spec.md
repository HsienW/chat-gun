# bff-stream-proxy Specification

## Purpose
TBD - created by archiving change bff-stream-cancellation-error-contract. Update Purpose after archive.
## Requirements
### Requirement: BFF stream proxy MUST use Node 22 AbortSignal reason for transport aborts

BFF MUST target Node 22 and use structured abort reasons when aborting upstream LangGraph requests.

#### Scenario: BFF timeout aborts upstream

- **WHEN** upstream LangGraph request exceeds `BFF_UPSTREAM_TIMEOUT_MS`
- **THEN** BFF MUST abort the upstream request with an abort reason whose code is `bff_timeout`
- **AND** public error classification MUST use that structured reason rather than error message text

#### Scenario: Runtime baseline is enforced

- **WHEN** BFF package metadata is evaluated
- **THEN** it MUST declare Node runtime support compatible with Node 22 or newer
- **AND** implementation MAY rely on `AbortSignal.reason`

### Requirement: BFF MUST propagate downstream disconnect to upstream

BFF MUST detect client disconnect during request body reading and upstream response streaming, then release resources and abort upstream work.

#### Scenario: Client disconnects while request body is being read

- **WHEN** the request emits `close` before the incoming message is complete
- **THEN** BFF MUST classify the request as `client_disconnected`
- **AND** BFF MUST NOT proxy a partial request body upstream

#### Scenario: Client disconnects while upstream stream is being proxied

- **WHEN** the response emits `close` before normal stream completion
- **THEN** BFF MUST abort the upstream stream with abort reason code `client_disconnected`
- **AND** BFF MUST stop writing chunks to the downstream response

#### Scenario: Frontend deliberate cancel uses existing stream stop path

- **WHEN** frontend calls the existing stream stop behavior and BFF observes only a closed downstream connection
- **THEN** BFF MUST classify the transport event as `client_disconnected`
- **AND** BFF MUST NOT emit `client_cancelled` unless a future explicit cancel API exists

### Requirement: BFF stream errors MUST have terminal behavior after headers are sent

BFF MUST avoid pretending a partially streamed response can be replaced by JSON after headers or chunks have already been sent.

#### Scenario: Stream error occurs before headers are sent

- **WHEN** upstream fetch or stream setup fails before response headers are sent
- **THEN** BFF MUST return an HTTP error response with a structured `ErrorEnvelope`
- **AND** the envelope MUST contain a stable code and safe message

#### Scenario: Stream error occurs after SSE headers are sent

- **WHEN** a stream error occurs after headers are sent and the downstream response is SSE-compatible
- **THEN** BFF MUST send a trailing `event: error` frame when the response remains writable
- **AND** the frame data MUST contain a safe `ErrorEnvelope` with `source: "bff"` and `stage: "langgraph_stream_proxy"`

#### Scenario: Stream error occurs after non-SSE headers are sent

- **WHEN** a stream error occurs after headers are sent and the downstream response is not SSE-compatible
- **THEN** BFF MUST NOT inject JSON into the existing response body
- **AND** BFF MUST terminate the response safely and write structured audit information

### Requirement: BFF error code classification MUST be structured

BFF MUST classify public error codes from structured abort reason and Node/Undici cause metadata, not from broad natural-language message regex.

#### Scenario: AbortSignal reason contains a code

- **WHEN** an upstream request fails due to an AbortSignal with a structured reason code
- **THEN** BFF MUST use that reason code as the primary classification source

#### Scenario: Network error has a structured cause code

- **WHEN** upstream fetch fails with a cause code such as `ECONNREFUSED`, `ENOTFOUND`, or `ECONNRESET`
- **THEN** BFF MUST map it to a stable network-related error code
- **AND** BFF MUST preserve safe cause metadata for diagnostics

#### Scenario: Error message contains timeout-like text

- **WHEN** an unknown error message contains words such as `fetch failed`, `connect`, `network`, or `timeout`
- **THEN** BFF MUST NOT use those words as the primary public code classification
- **AND** BFF MAY record them only as an internal telemetry hint

### Requirement: BFF stream proxy MUST avoid new environment variables for this change

BFF MUST use existing timeout configuration for upstream fetch and stream lifetime.

#### Scenario: Upstream stream lifetime is configured

- **WHEN** BFF needs to bound upstream fetch or stream duration
- **THEN** it MUST use existing `BFF_UPSTREAM_TIMEOUT_MS`
- **AND** it MUST NOT introduce a new stream timeout environment variable in this Change

### Requirement: BFF MUST disable intermediary buffering for SSE passthrough

當上游回應為 SSE 串流時，BFF MUST 明確宣告中介層不得緩衝或轉換串流內容，且 BFF 自身 MUST NOT 以壓縮或聚合延後轉送。

#### Scenario: 上游為 SSE 串流

- GIVEN 上游回應媒體型別為 SSE 串流
- WHEN BFF 開始轉送
- THEN 下游回應 MUST 宣告停用代理緩衝（`X-Accel-Buffering: no`）
- AND MUST 宣告 `Cache-Control: no-cache, no-transform`

#### Scenario: 首框在上游暫停時已轉送

- GIVEN 上游送出第一框後暫停
- WHEN 下游讀取
- THEN 下游 MUST 已收到第一框
- AND MUST NOT 等待上游後續資料才轉送

#### Scenario: 非 SSE 回應不受影響

- GIVEN 上游回應不是 SSE 串流
- WHEN BFF 轉送
- THEN 既有 header 行為 MUST 不變

