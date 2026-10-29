[← 回到 README](../README.md)

# 可觀測性

- **Observability & Evaluation**：提供 Metrics 與 OpenTelemetry，並可啟用 Opik tracing。另附可重跑的檢索評測與流程評測，結果連同資料集版本、模型識別與日期一併記錄。

## Observability

BFF 提供 metrics endpoint：

```bash
curl http://127.0.0.1:8787/api/metrics
```

OpenTelemetry 預設關閉。連接 OTLP collector：

```env
OTEL_ENABLED=true
OTEL_SERVICE_NAME=chat-gun
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http
OTEL_SAMPLE_RATE=1
```

Opik 可用於開發期間的 Agent tracing 與評測。它預設關閉；啟用 hosted tracing 時應使用非正式環境資料，並保持 redaction 開啟。

```env
OPIK_ENABLED=true
OPIK_WORKSPACE=your_workspace
OPIK_API_KEY=your_opik_api_key
OPIK_REDACT_ENABLED=true
```

執行 Opik 評測：

```bash
cd backend
npm run eval:opik
```

知識庫的 embedding 與 rerank 呼叫會發出用量事件，可供後續的成本歸集使用；此版本尚未將它們彙總為帳務紀錄。

## 評測與架構

[完整評測與重跑方式](./evaluation.md) · [架構中的可觀測性](./architecture.md#可觀測性)
