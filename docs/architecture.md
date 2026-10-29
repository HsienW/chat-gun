[← 回到 README](../README.md)

# Agent 執行架構

<p>
  <a href="./architecture.en.md">English</a> |
  <a href="./architecture.md">繁體中文</a>
</p>

本文說明 Chat Gun 如何接收請求、選擇執行路徑、調用模型與工具，以及把結果串流回瀏覽器。若要了解各套件與擴充位置，請參閱 [TypeScript + LangGraph 程式碼架構](./typescript-langgraph-architecture.md)。

## 請求流程

```text
Browser
  │
  │ LangGraph SDK streaming
  ▼
Frontend（React）
  │
  │ /api/langgraph/*
  ▼
BFF（認證、CORS、限流、請求檢查、逾時與取消）
  │
  ▼
LangGraph Agent Server
  │
  ├─ TypeScript graphs
  ├─ LLM Gateway ── Qwen / OpenAI-compatible / CCR
  └─ Tool Registry ── Native tools / MCP servers
```

Frontend 預設透過同一個 origin 的 `/api/langgraph` 連到 BFF。BFF 驗證外部請求後，把 LangGraph API 路徑與串流內容轉送到 backend。這層也會傳遞 `x-request-id`、W3C Trace Context、取消訊號與允許的身分欄位。完整的外部 API 行為請參閱 [BFF API Gateway](./bff.md)。

## 可用 Agent

Agent Server 依 `backend/langgraph.json` 註冊四個 graph：

| Graph ID | 執行方式 | 適用情境 |
| --- | --- | --- |
| `deep_researcher` | 規劃後選擇直接回答、特定工具或多步驟網路研究 | 研究、天氣、計算、來源整理與圖片理解 |
| `chatbot` | 單一模型節點 | 一般對話 |
| `math_agent` | 優先使用 calculator，無法抽取算式時改由模型回答 | 數學問題與數值運算 |
| `mcp_agent` | 模型與 ToolNode 循環，直到不再產生 tool call | 使用已啟用的 native 或 MCP tools |

## Deep Researcher 流程

`deep_researcher` 先驗證上傳內容、建立對話 context，再由 planner 選擇最合適的路徑。

```text
START
  │
  ▼
validate_uploads
  │
  ├─ 上傳錯誤 ───────────────────────────────┐
  ▼                                          │
build_context_pack                           │
  │                                          │
  ▼                                          │
analyze_images                               │
  │                                          │
  ▼                                          │
plan_research                                │
  │                                          │
  ├─ direct ─────────────────────────────────┤
  ├─ weather / calculation                   │
  │      ▼                                   │
  │   targeted_tools                         │
  │      ├─ 需要地點確認 → clarify_interrupt │
  │      │                    │ resume        │
  │      │                    ▼               │
  │      │               resume_clarify ─────┤
  │      └────────────────────────────────────┤
  │                                          │
  └─ research                                │
         ▼                                   │
      search_web                             │
         ▼                                   │
      rank_sources                           │
         ▼                                   │
      fetch_sources                          │
         ▼                                   │
      extract_evidence                       │
         ▼                                   │
      verify_citations                       │
         │                                   │
         └───────────────────────────────────┤
                                             ▼
                                      synthesize_answer
                                             │
                                            END
```

搜尋沒有結果或來源不足時，router 可以略過不必要的節點並直接進入驗證或合成答案。最終回應只由 `synthesize_answer` 產生，讓成功、工具錯誤、上傳錯誤與取消都收斂到同一個終點。

## State 與 checkpoint

Deep Researcher 的 state 由 LangGraph `Annotation.Root` 定義。主要欄位如下：

| 欄位 | 用途 |
| --- | --- |
| `messages` | 對話訊息與工具結果 |
| `contextPack` | 經整理與預算控制的對話 context |
| `plan` | planner 產生的回答模式、查詢與工具參數 |
| `searchResults` | 搜尋結果 |
| `rankedSources` | 排序後的候選來源 |
| `fetchedSources` | 已取得的網頁內容 |
| `extractedSources` | 可供引用的證據 |
| `verification` | 引用與來源驗證結果 |
| `imageObservations` | 圖片分析結果 |
| `weatherExecution` | 天氣工具的執行狀態與結果 |
| `clarification` | 等待使用者確認地點時的狀態 |

State 必須保持可序列化，不能存放 provider client、stream、callback、timer 或 `AbortController` 等執行期物件。

Deep Researcher 使用 LangGraph `MemorySaver` 保存 process 內的對話執行狀態。天氣地點有多個候選時，graph 透過 `interrupt()` 暫停；使用者選擇候選地點、提供新地點或取消後，再以相同 thread 恢復執行。恢復操作必須回到持有該 checkpoint 的 backend process；需要跨重啟或多實例恢復時，部署者應改用相容的 durable checkpointer。

## 模型與工具邊界

所有模型呼叫都經過 `backend/src/platform/llm-gateway.ts`。Gateway 支援 `qwen`、`openai-compatible` 與 `ccr`，並在送出請求前檢查模型能力：

- Structured output 需要 `supportsStructuredOutput`。
- Tool calling 需要 `supportsToolCalling` 與 `bindTools`。
- 圖片輸入需要 `supportsVision`。

Provider fallback 由呼叫端明確選用，不會因為宣告多個 Provider 就自動切換。結構化輸出會先解析與正規化；資料不完整時採用安全的 fallback plan，不把 provider 原始回應或 stack trace 暴露給使用者。

Deep Researcher 與 MCP Agent 透過 Tool Registry 載入 native／MCP tools；這條路徑會套用 enable/disable、allowlist/denylist、輸入大小、逾時與輸出大小檢查。Math Agent 則直接調用 calculator，不經 Registry。網頁抓取與 Filesystem MCP 的網路及路徑限制請參閱 [Tool 與 MCP 安全設定](./tool-security-isolation.md)。

## 串流事件

Backend 與 Frontend 共用相同的 Agent runtime event 類型：

- `agent.plan.start`
- `agent.tool.start`
- `agent.tool.success`
- `agent.tool.error`
- `agent.context.build`
- `agent.answer.stream`
- `agent.card.emit`
- `agent.unknown`

Frontend 會把事件轉成活動時間軸與答案串流。無法辨識的新事件會保留為 `agent.unknown`，避免舊版客戶端因新增事件類型而中斷。可重用的 task state machine 將 `completed`、`failed` 與 `cancelled` 定義為 terminal state，這些狀態沒有返回 `running` 的合法 transition。

## 可觀測性

- BFF 保留並轉送 W3C `traceparent`／`tracestate`，讓 backend 能延續上游 trace context。
- `/api/metrics` 透過 BFF 提供 backend 的 JSON metrics snapshot。
- OpenTelemetry 可輸出 graph node、LLM 與修復流程的 spans。
- Opik 可記錄開發環境的 graph、LLM 與 tool traces，並支援 `backend/src/evaluation/` 的評估工作。
- Tool audit event 只保留可診斷的 metadata；敏感輸入與輸出必須經過遮蔽。

OpenTelemetry 與 Opik 都由環境變數啟用，未設定時不影響主要請求流程。

## 入口與互動能力

- **Streaming**：即時串流回答與執行活動，支援取消與錯誤處理，使用者能中止進行中的請求並看見明確的錯誤狀態。
- **Human-in-the-Loop**：訂單操作的核准流程；天氣地點不明確時，Agent 會列出候選地點向使用者確認，再接續原本的對話執行。
- **Multimodal input**：接受 PNG、JPEG 與 WebP 圖片，透過 vision model 分析內容並納入回答或研究流程。
- **Model providers**：支援 Qwen、OpenAI-compatible 與 CCR-compatible endpoints，統一由 LLM Gateway 處理模型能力與呼叫介面。

Gun Shop 的入口、已註冊 Graph 與操作流程見 [Gun Shop](./gun-shop.md)；模型與各層設定見[設定](./configuration.md)。
