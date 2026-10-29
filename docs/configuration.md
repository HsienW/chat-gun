[← 回到 README](../README.md)

# 設定

## Backend

從範例建立本地設定：

```bash
cp backend/.env.example backend/.env
```

PowerShell：

```powershell
Copy-Item backend/.env.example backend/.env
```

使用 Qwen 時，至少填入：

```env
LLM_PROVIDER=qwen
QWEN_API_KEY=your_qwen_api_key
```

Deep Researcher 的內建 `web_search` 使用 Tavily Search API：

```env
TAVILY_API_KEY=your_tavily_api_key
```

也可以連接其他模型端點：

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

其他模型、圖片、天氣、Tool 與 MCP 設定請參閱 [`backend/.env.example`](../backend/.env.example)。不要將 API key 或其他 credential 提交到版本控制。

## 知識庫

知識庫使用與 LangGraph checkpoint **分開**的資料庫，連線字串以 secret reference 解析，不在工具或流程內直接讀取環境變數。

```env
# 知識庫連線（使用 Docker Compose 時，主機埠為 5434）
KNOWLEDGE_DATABASE_URL=postgresql://postgres:postgres@localhost:5434/knowledge
```

檢索行為以下列設定控制。Embedding 模型識別與維度屬於版本化設定；維度改變需要重建索引，不會靜默混用。

| 環境變數 | 用途 |
| --- | --- |
| `KB_EMBEDDING_MODEL` | Embedding 模型識別（評測使用 `text-embedding-v4`） |
| `KB_EMBEDDING_DIMENSIONS` | 向量維度，必須與索引一致（評測使用 `1024`） |
| `KB_EMBEDDING_MAX_BATCH` | 單批 embedding 請求上限 |
| `KB_RERANK_MODEL` | Rerank 模型識別（評測使用 `qwen3-rerank`） |
| `KB_RERANK_URL` | Rerank 端點 |
| `KB_CANDIDATE_COUNT` | 候選片段數量 |
| `KB_VECTOR_THRESHOLD` | 向量召回的證據門檻 |
| `KB_RERANK_THRESHOLD` | Rerank 後的證據門檻 |
| `KB_THRESHOLD_VERSION` | 門檻設定版本 |
| `KB_CHUNK_TARGET_CHARS` | 切塊目標長度 |
| `KB_CHUNK_OVERLAP_CHARS` | 切塊重疊長度 |
| `KB_CHUNKING_POLICY_VERSION` | 切塊政策版本 |
| `KB_CORPUS_TENANT_ID` | 語料所屬 tenant |
| `KB_REQUEST_TIMEOUT_MS` | 檢索請求逾時 |
| `QWEN_BASE_URL` | Embedding 與 rerank 的服務位址 |

評測另有兩個變數指定使用的模型：`KB_EVAL_GENERATION_MODEL`（回答生成）與 `KB_EVAL_JUDGE_MODEL`（模型輔助評分）。

檢索為 tenant 範圍內查詢，tenant 只由 Server 端 context 決定，不接受來自模型輸出或客戶端的宣稱。來源文件刪除時，其片段與索引項目會一併移除。

## BFF

```bash
cp bff/.env.example bff/.env
```

PowerShell：

```powershell
Copy-Item bff/.env.example bff/.env
```

| 環境變數 | 用途 |
| --- | --- |
| `BFF_LANGGRAPH_API_URL` | LangGraph API URL |
| `BFF_ALLOWED_ORIGINS` | 允許存取 BFF 的瀏覽器 origins |
| `BFF_REQUIRE_AUTH` | 是否要求 API key 或 Bearer token；啟用時還需要對應的 Trusted Principal profile |
| `BFF_API_KEYS` | 通常留空；若設定，每個 key 仍需有對應的 Principal profile |
| `BFF_API_KEY_PRINCIPALS_JSON` | 以 API key 為索引的 Principal profile JSON，包含 `principalId`、`principalType`、`tenantId`、`roles` 與 `scopes` |
| `BFF_LEGACY_HEADER_MODE` | 是否繼續向 Backend 傳送相容用的 `x-bff-user-id`；預設為 `true` |
| `BFF_MAX_BODY_BYTES` | Request body 上限 |
| `BFF_UPSTREAM_TIMEOUT_MS` | Upstream request timeout |
| `BFF_RATE_LIMIT_REDIS_URI` | Redis rate limiter；留空時使用 in-memory limiter |

其他 BFF 選項請參閱 [`bff/.env.example`](../bff/.env.example)。

啟用 BFF authentication 時，每個 API key 都必須具有 Trusted Principal profile；只設定 `BFF_API_KEYS` 會因缺少可信身分資料而回傳 `401`。BFF 會忽略 client 傳入的 `x-user-id`／`x-tenant-id`，並依 profile 產生及轉送 `x-bff-*` headers 至 Backend。Resource-level authorization 由需要保護的 Tool 或 workflow 顯式啟用。

```env
BFF_REQUIRE_AUTH=true
BFF_API_KEY_PRINCIPALS_JSON={"replace-with-a-long-random-key":{"principalId":"local-user","principalType":"user","tenantId":"local","roles":[],"scopes":[]}}
```

`BFF_API_KEY_PRINCIPALS_JSON` 的 JSON key 本身就是 credential，請只透過環境變數或 secret manager 提供，不要提交到版本控制。

**對話 state 的寫入防護。** 核准紀錄與待執行的工具呼叫都存在對話 state 中，因此 BFF 在轉送前會拒絕下列請求：更新 thread state、建立 thread 時預寫 state，以及 `command` 中夾帶 `resume` 以外的欄位。核准所需的決策識別由 Server 端紀錄驗證，客戶端無法偽造。

## Frontend

本地開發不需要建立 `frontend/.env`。Frontend 預設使用同源 `/api/langgraph`；分開部署時可指定 BFF URL：

```env
VITE_LANGGRAPH_API_URL=https://api.example.com/api/langgraph
```

圖片輸入限制請參閱 [`frontend/.env.example`](../frontend/.env.example)。`VITE_*` 會出現在瀏覽器 bundle，不能用來保存 secret。

## 延伸閱讀

[快速開始](./getting-started.md) · [知識庫檢索](./retrieval.md) · [BFF 與安全](./bff.md)
