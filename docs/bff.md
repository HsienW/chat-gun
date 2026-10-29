[← 回到 README](../README.md)

# BFF API gateway

<p>
  <a href="./bff.en.md">English</a> |
  <a href="./bff.md">繁體中文</a>
</p>

BFF 是瀏覽器對外的 HTTP 入口。Frontend 透過 BFF 存取 LangGraph API，模型與 Tool credential 不會進入瀏覽器 bundle。

## 本機路由

```text
Frontend  http://localhost:5173/app/
  -> Vite proxy /api/*
BFF       http://127.0.0.1:8787
  -> /api/langgraph/*
Backend   http://localhost:2024
```

啟動服務：

```bash
cd backend && npm run dev
cd bff && npm run dev
cd frontend && npm run dev
```

Docker Compose 對外開放 `http://localhost:8123`。BFF 在同一個 origin 提供 `/app/` 靜態檔與 `/api/*`，LangGraph API、Redis 與 PostgreSQL 不需要直接暴露給瀏覽器。

## Endpoints

| Endpoint | Methods | 說明 |
| --- | --- | --- |
| `/api/health` | `GET` | BFF process health，不檢查 Backend |
| `/api/bff/health` | `GET` | `/api/health` alias |
| `/api/ready` | `GET` | 檢查 BFF 是否能連上 LangGraph Backend |
| `/api/bff/ready` | `GET` | `/api/ready` alias |
| `/api/langgraph/*` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` | LangGraph API proxy |
| `/api/metrics` | `GET`, `HEAD` | Backend metrics proxy |
| `/app/*` | `GET` | 已建置的 Frontend 與 SPA fallback |

所有回應都會帶有 `x-request-id`。Client 可以傳入自己的 `x-request-id`；未提供時由 BFF 產生。

## 設定

從範例建立本機設定：

```bash
cp bff/.env.example bff/.env
```

| 環境變數 | 預設值 | 用途 |
| --- | --- | --- |
| `BFF_PORT` | `8787` | BFF listen port |
| `BFF_LANGGRAPH_API_URL` | `http://localhost:2024` | LangGraph API URL |
| `BFF_FRONTEND_DIST` | `../frontend/dist` | Frontend build 目錄 |
| `BFF_ALLOWED_ORIGINS` | 空 | CORS allowlist |
| `BFF_REQUIRE_AUTH` | `false` | 是否要求 API key／Bearer token；啟用時必須設定 Principal profiles |
| `BFF_API_KEYS` | 空 | 通常留空；若設定，每個 key 仍需有對應的 Principal profile |
| `BFF_API_KEY_PRINCIPALS_JSON` | 空 | 以 API key 為索引的 Principal profile JSON |
| `BFF_LEGACY_HEADER_MODE` | `true` | 是否另外向 Backend 傳送 `x-bff-user-id` |
| `BFF_MAX_BODY_BYTES` | `52428800` | Request body 上限 |
| `BFF_UPSTREAM_TIMEOUT_MS` | `120000` | LangGraph 與 metrics upstream timeout |
| `BFF_RATE_LIMIT_REDIS_URI` | 空 | Redis rate limiter URL |
| `AGENT_METRICS_BACKEND_URL` | 同 `BFF_LANGGRAPH_API_URL` | Metrics backend URL |

圖片輸入另受 `BFF_IMAGE_UPLOAD_*` 限制。常用設定範例請參閱 [`bff/.env.example`](../bff/.env.example)。

Docker Compose 會把 `BFF_MAX_BODY_BYTES` 預設覆寫為 `1048576`（1 MiB）。需要上傳較大的圖片 payload 時，請在啟動 Compose 前明確設定合適的上限。

## Authentication

啟用認證：

```env
BFF_REQUIRE_AUTH=true
BFF_API_KEY_PRINCIPALS_JSON={"replace-with-a-long-random-key":{"principalId":"local-user","principalType":"user","tenantId":"local","roles":[],"scopes":[]}}
```

`BFF_API_KEY_PRINCIPALS_JSON` 必須是單行 JSON object。最外層 key 是 client 使用的 API key；profile 提供 BFF 轉送至 Backend 的可信 Principal 與 tenant context。API key 是 credential，請透過環境變數或 secret manager 提供，不要提交真實值。

Client 可使用任一格式：

```http
X-API-Key: replace-with-a-long-random-key
```

```http
Authorization: Bearer replace-with-a-long-random-key
```

認證會套用至 `/api/langgraph/*` 與 `/api/metrics`。Health、readiness 與 Frontend 靜態檔不要求 API key。

啟用認證時，每個 API key 都必須在 `BFF_API_KEY_PRINCIPALS_JSON` 中有對應 profile；只設定 `BFF_API_KEYS` 會回傳 `401`。一般設定可讓 `BFF_API_KEYS` 保持空白。

BFF 不信任或轉送 client 傳入的 `x-user-id`／`x-tenant-id`。它會從驗證成功的 profile 產生 `x-bff-principal-id`、`x-bff-principal-type`、`x-bff-tenant-id`、`x-bff-roles`、`x-bff-scopes`、`x-bff-auth-source` 與 `x-bff-authenticated-at`。需要 `x-bff-user-id` 時可保留 `BFF_LEGACY_HEADER_MODE=true`。

## CORS

`BFF_ALLOWED_ORIGINS` 使用逗號分隔的完整 origins：

```env
BFF_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

`BFF_ALLOWED_ORIGINS` 為空時，BFF 會接受任何 origin；正式部署應設定明確 allowlist。分開部署 Frontend 與 BFF 時，必須加入 Frontend origin。BFF 允許 `GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`HEAD` 與 `OPTIONS`。

## Rate limiting

設定 `BFF_RATE_LIMIT_REDIS_URI` 後，BFF 會分別計算已解析 Principal 與 socket-peer IP 配額；任一維度超限就回傳 `429`。

```env
BFF_RATE_LIMIT_REDIS_URI=redis://localhost:6379
BFF_RATE_LIMIT_USER_MAX_REQUESTS=30
BFF_RATE_LIMIT_USER_WINDOW_MS=60000
BFF_RATE_LIMIT_IP_MAX_REQUESTS=20
BFF_RATE_LIMIT_IP_WINDOW_MS=60000
```

Redis 未設定時使用 process-local in-memory limiter。Redis 執行期間發生錯誤時，該維度會降級到獨立的 in-memory bucket。多實例部署若需要共享配額，應設定 Redis。

Rate-limit 回應包含：

- `Retry-After`
- `x-ratelimit-limit`
- `x-ratelimit-remaining`
- `x-ratelimit-reset`
- JSON 欄位 `error` 與 `retryAfter`

## Request forwarding

BFF 會移除 hop-by-hop headers，只轉送明確允許的 request headers。常用項目包括：

- `accept`、`accept-language`、`content-type`、`user-agent`
- `authorization`、`x-api-key`
- `x-idempotency-key`
- `traceparent`、`tracestate`

BFF 會設定 `x-request-id` 及驗證後的 `x-bff-*` identity headers；client 無法用同名 headers 覆寫這些值。W3C Trace Context 會原樣傳給 Backend，供 OpenTelemetry 建立跨服務 trace。

## Upload validation

送往 LangGraph 的 request body 會先檢查整體大小。若 payload 包含圖片，BFF 也會檢查：

- 檔案數量
- 每張圖片的 encoded bytes
- 圖片寬高與總 pixels
- 副檔名與 MIME type
- 可選的 object-storage URL

不符合限制時回傳 `400`；body 超過 `BFF_MAX_BODY_BYTES` 時回傳 `413`。Frontend 與 Backend 也有各自的圖片 preflight，三層限制應保持一致。

## Timeout、streaming 與 cancellation

`BFF_UPSTREAM_TIMEOUT_MS` 同時限制一般 LangGraph request、stream consumption 與 metrics proxy。Client 中斷連線時，BFF 會取消 upstream fetch。

若錯誤發生在 SSE stream 開始前，BFF 回傳 JSON error envelope；若 stream 已開始，BFF 會盡可能寫入 SSE error frame。結構化錯誤包含 `source`、`stage`、`code`、`message` 與可選的 `details`／`cause`，並保留同一個 `requestId` 供查詢 log。

## Audit logs

BFF 在 request 完成時輸出 JSON audit log，內容包括 request ID、method、path、status、duration、已解析的 Principal、tenant 與 client IP。Log 不應額外加入 authorization header、API key 或完整 request body。

## 對話 state 的寫入防護

**對話 state 的寫入防護。** 核准紀錄與待執行的工具呼叫都存在對話 state 中，因此 BFF 在轉送前會拒絕下列請求：更新 thread state、建立 thread 時預寫 state，以及 `command` 中夾帶 `resume` 以外的欄位。核准所需的決策識別由 Server 端紀錄驗證，客戶端無法偽造。

Gun Shop 核准與操作狀態見 [Gun Shop](./gun-shop.md)；完整 BFF 環境變數摘要見[設定](./configuration.md#bff)。
