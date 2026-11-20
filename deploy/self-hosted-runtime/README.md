# 自建 LangGraph Runtime

本目錄提供以未修補的 MIT 開源 LangGraph server 建置 backend runtime 映像所需的檔案。單一實例部署的適用條件與已知限制見[可行性規格](../../openspec/specs/self-hosted-runtime-feasibility/spec.md)與[封存的 spike 結論](../../openspec/changes/archive/2026-11-19-spike-mit-langgraph-server/findings.md)。

## 建置

在 repository 根目錄執行下列命令。第二個映像包含 BFF 與編譯後的前端。

```sh
docker build -f deploy/self-hosted-runtime/Dockerfile --target runtime -t chat-gun-runtime:local .
docker build -f deploy/self-hosted-runtime/Dockerfile --target bff -t chat-gun-bff:local .
```

## 啟動與設定

啟動 runtime 容器時，映像入口 `/bin/sh /usr/local/bin/runtime-entrypoint.sh` 會執行 `node --import tsx /app/backend/start-runtime.mjs`。啟動程式讀取 `langgraph.json`，透過套件公開的 `startServer` API 啟動服務，沿用套件的 checkpointer。

| 環境變數 | 用途 |
| --- | --- |
| `RUNTIME_HOST` | 服務監聽的位址 |
| `RUNTIME_PORT` | 服務監聽的 TCP 連接埠 |
| `RUNTIME_WORKERS` | 處理工作的 worker 數量 |

部署設定與密鑰由部署環境在容器啟動時注入。設定鍵名與用途見[部署成本與存取設定](../../docs/demo-cost-and-access-guard.md)。

## 版本與授權

`@langchain/langgraph-api` 與 `@langchain/langgraph-cli` 使用 MIT 授權，版本由 backend 的 `package-lock.json` 鎖定為 1.4.5。Dockerfile 以 SHA-256 digest 固定 Node.js 基底映像。

歷史驗證工具保存在 commit `d4835b5`。
