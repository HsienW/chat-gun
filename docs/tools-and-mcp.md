[← 回到 README](../README.md)

# Tools 與 MCP

- **Native Tools**：內建計算、網路搜尋（Tavily Search API）、網頁擷取、目前天氣、天氣預報、知識庫檢索與模擬訂單操作。
- **MCP integration**：可選擇載入 Filesystem 與 Brave Search MCP Server。
- **Agent／Tool SDK**：提供具型別的 Agent 與 Tool 宣告方式，並以版本化 manifest 描述輸入輸出、副作用類別、所需權限與執行條件。工具只授予在 manifest 中宣告的 Agent，其他流程不會載入。

## Tools

| Tool | 用途 | 副作用類別 | 必要設定 |
| --- | --- | --- | --- |
| `calculator_tool` | 算術運算 | 唯讀 | 無 |
| `web_search` | Tavily Search API 網路搜尋 | 唯讀（對外） | `TAVILY_API_KEY` |
| `web_fetch` | HTTP／HTTPS 網頁擷取 | 唯讀（對外） | 無 |
| `current_weather` | Open-Meteo 目前天氣 | 唯讀（對外） | 無 |
| `weather_forecast` | Open-Meteo 天氣預報 | 唯讀（對外） | 無 |
| `kb_search` | 私有語料檢索，回傳帶來源出處的片段 | 唯讀 | `KNOWLEDGE_DATABASE_URL`、`QWEN_API_KEY` |
| `order_refund_request` | 送出退款申請（模擬訂單系統） | 外部狀態變更，需人工核准 | 無 |
| `order_cancel` | 取消訂單（模擬訂單系統） | 外部狀態變更，需人工核准 | 無 |
| `order_operation_status` | 查詢訂單操作目前狀態 | 唯讀 | 無 |

可以使用 `TOOL_ALLOWLIST`、`TOOL_DENYLIST`、`TOOL_TIMEOUT_MS` 與個別 Tool 設定限制可用範圍。`web_fetch` 預設只允許 port `80`、`443`，並拒絕不安全的 private network address。知識庫的 embedding 與 rerank 呼叫同樣受對外連線政策約束。

訂單工具只透過 `shopping_assistant` 的 Agent manifest 授予，其他 Graph 不會載入它們。所有工具都經由統一的 Tool Dispatch 執行，流程節點不會直接呼叫工具。

### 擴充 Agent 與 Tool

- TypeScript 開發者可使用以下 Tool
  - [`@gun-ai/harness-sdk`](https://www.npmjs.com/package/@gun-ai/harness-sdk) 的 `defineAgent`、`defineTool`
    - 宣告 Agent 與 Tool，並透過版本化 manifest 指定資料格式、副作用類別、所需權限、執行環境與重試等條件。
    - 註冊時會驗證宣告；不完整或互相矛盾的設定會被拒絕。

  - [`@gun-ai/harness-testkit`](https://www.npmjs.com/package/@gun-ai/harness-testkit)
    - 提供測試輔助工具。本專案使用 alpha 版本，擴充時請固定相容版本。

- 要在 Chat Gun 使用自訂 Tool，仍需在 Backend 接入實作並設定授權與執行環境；安裝 SDK 不會自動啟用 Tool，也不會略過既有的安全檢查。

## MCP

MCP tools 預設不會在啟動時載入。啟用 Filesystem MCP：

```env
MCP_LOAD_ON_START=true
MCP_FILESYSTEM_ENABLED=true
MCP_FILESYSTEM_PATH=/absolute/path/to/workspace
MCP_FILESYSTEM_ALLOWED_ROOTS=/absolute/path/to/workspace
```

讓 Deep Researcher 使用 MCP tools：

```env
DEEP_RESEARCHER_MCP_ENABLED=true
```

啟用選配的 Brave Search MCP Server：

```env
MCP_BRAVE_SEARCH_ENABLED=true
BRAVE_API_KEY=your_brave_api_key
```

`MCP_FILESYSTEM_PATH` 必須位於 `MCP_FILESYSTEM_ALLOWED_ROOTS` 內。多個 root 在 Windows 使用 `;` 分隔，在 Linux／macOS 使用 `:`。

MCP server 的執行環境必須宣告為獨立行程；不符合的宣告會在註冊階段被拒絕，而不是在執行時才失敗。

## 安全與隔離

工具與 MCP 的權限、路徑及網路邊界請參閱 [Tool 與 MCP 安全設定](./tool-security-isolation.md)；目前尚未出貨的隔離能力見[範圍與限制](./scope-and-limitations.md)。
