[← 回到 README](../README.md)

# 快速開始與本地開發

> 📌
> 預設僅適用於本地開發。公開部署前，請啟用 Authentication、設定明確的 CORS allowlist、妥善管理 Secrets 與資料庫憑證，並依部署架構配置共享 Rate limiting、TLS 與 Reverse Proxy。若需要跨重啟或多實例恢復 Agent 執行，請改用 durable checkpointer。

## 系統需求

- Node >= 22
- npm >= 10.8.x
- Qwen API key，或可用的 OpenAI-compatible／CCR-compatible endpoint
- PostgreSQL 16 與 `pgvector` extension（使用知識庫檢索時需要；Docker Compose 已內含）
- Tavily Search API key（使用內建 `web_search` 時需要）
- Brave Search API key（啟用 Brave Search MCP Server 時需要，選用）
- Docker 與 Docker Compose（選用）

## 安裝

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

## 設定入口

模型、知識庫與各層環境變數請參閱[設定](./configuration.md)。

本地開發時，Frontend 會把 `/api/*` 代理至 BFF；LangGraph 請求經由 `/api/langgraph/*` 轉送到 Backend。模型、Tool、知識庫與 MCP credential 只保留在 Server 端。

```text
http://localhost:5173/app/
  -> http://127.0.0.1:8787/api/langgraph/*
  -> http://localhost:2024
```

## 本地開發

分別啟動 Backend、BFF 與 Frontend。

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

開啟 <http://localhost:5173/app/>。

### 準備知識庫

Gun Shop 的商品查詢與政策問答需要先匯入語料。先啟動一個帶 `pgvector` 的 PostgreSQL（可直接用 Compose 的 `knowledge-postgres`），確認 `KNOWLEDGE_DATABASE_URL` 指向它，然後：

```bash
cd backend

# 產生合成語料（商品與政策／FAQ 文件，標記為合成資料）
npm run knowledge:corpus

# 建立知識庫結構並匯入
npm run migrations:up
npm run knowledge:ingest
```

匯入可指定語料目錄與 tenant：

```bash
npm run knowledge:ingest -- --corpus <dir>
npm run knowledge:ingest -- --tenant <tenantId>
```

匯入是可續跑且具冪等性的：中斷後重跑會跳過已完成的片段，重複送出同一份語料不會產生重複資料。每個片段都會記錄來源文件識別、來源版本、位移、資料分級與匯入批次識別。

### 健康檢查

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/ready
```

PowerShell：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
Invoke-RestMethod http://127.0.0.1:8787/api/ready
```

`/api/ready` 會檢查 BFF 是否能連上 LangGraph Backend。

## Docker Compose

Docker Compose 會啟動 PostgreSQL、Redis、帶 `pgvector` 的知識庫 PostgreSQL、LangGraph API 與 BFF，並由 BFF 提供建置後的 Frontend。

| 服務 | 映像 | 主機埠 |
| --- | --- | ---: |
| `langgraph-postgres` | `postgres:16` | `5433` |
| `langgraph-redis` | `redis:6` | — |
| `knowledge-postgres` | `pgvector/pgvector:pg16` | `5434` |
| `langgraph-api` | `chat-gun` | — |
| `bff` | `chat-gun-bff` | `8123` |

在專案根目錄建立 `.env`：

```env
QWEN_API_KEY=your_qwen_api_key
TAVILY_API_KEY=your_tavily_api_key
LANGSMITH_API_KEY=your_langsmith_api_key_with_langgraph_cloud_access
```

Compose 使用的 LangGraph API 映像會驗證授權。若容器日誌顯示 LangSmith `/auth?langgraph-api=true` 回傳 403，請確認 `LANGSMITH_API_KEY` 所屬帳號具備 LangGraph Cloud 存取權，或依部署授權在 `langgraph-api.environment` 傳入 `LANGGRAPH_CLOUD_LICENSE_KEY`。

若憑證已設於 `backend/.env`，下列 `docker compose` 命令需加上 `--env-file backend/.env`。Docker 映像不會打包 `.env`；Compose 僅傳遞 LangSmith key 作為授權設定，關閉 LangSmith tracing，並依 `OPIK_*` 設定啟用 Opik tracing。Hosted tracing 僅適合已核准且完成資料遮蔽的環境。

應用持久化使用獨立的 `DATABASE_URL` 設定；`POSTGRES_URI` 是 LangGraph 伺服器的連線設定，不會配置應用的資料庫連線。首次執行時，先啟動 Compose 的兩個 PostgreSQL，將 `backend/.env` 的 `DATABASE_URL` 與 `KNOWLEDGE_DATABASE_URL` 指向主機上的埠 `5433` 與 `5434`，再執行遷移與語料匯入：

```bash
docker compose up -d langgraph-postgres knowledge-postgres
npm --prefix backend run migrations:up
npm --prefix backend run knowledge:corpus
npm --prefix backend run knowledge:ingest
```

Compose 已在 `langgraph-api.environment` 傳入使用容器內埠 `5432` 的連線字串；本機 `backend/.env` 則使用主機埠 `5433` 與 `5434`。**注意**：若 `backend/.env` 中的 `KNOWLEDGE_DATABASE_URL` 指向主機的 `localhost:5434`，這個值會被帶進容器，造成容器內無法連上知識庫。在容器環境請改用服務名稱 `knowledge-postgres:5432`。

啟動服務：

```bash
docker compose up --build
```

開啟 <http://localhost:8123/app/>。

Compose 預設使用 Qwen。改用其他 provider 或啟用額外 Backend 功能時，請把對應環境變數加入 `docker-compose.yml` 的 `langgraph-api.environment`。

## 測試

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

Backend 的 `lint` 包含資料庫遷移的相容性檢查與 TypeScript 檢查。並行重複送出的去重、核准逾期與取消競態都有整合測試覆蓋，其中並行案例以實際並行送出驗證，而非依序呼叫。
