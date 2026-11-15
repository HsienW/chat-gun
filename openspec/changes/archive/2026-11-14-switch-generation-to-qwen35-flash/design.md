## Context

r2 計畫 1B-1：所有已註冊 graph 改用 `qwen3.5-flash` 生成，thinking 預設關閉（B12：Gun Shop 一律關閉並在啟動時驗證；Gun Chat 預設關閉），並在 provenance 記錄實際模型。本 Change 是 `demo-cost-and-access-guard` tasks 6.4(c) 的部署前 Gate，也是 1B-2～1B-7 的前提。

### 現況盤點（2026-11-04，工作樹含其他 Change 未提交的修改）

| 位置 | 現況 | 與 1B-1 的關係 |
|---|---|---|
| LLM Gateway 的 Qwen 模型解析 | 解析順序：呼叫端指定 model → `QWEN_<PURPOSE>_MODEL` → legacy（`CHAT_MODEL`／`MATH_MODEL`／`MCP_AGENT_MODEL`／`DEFAULT_MODEL`）→ 程式內寫死 `qwen-plus`（vision 為 `qwen-vl-plus`）。 | 程式預設要改為單一來源常數。 |
| LLM Gateway 的 thinking | `OpenAiCompatibleChatModel` 只在 `thinkingEnabled !== undefined` 時送出 `enable_thinking`。`configureChatModelDefaults` 只在 demo 模式由 `application` 呼叫，且只有 `chatbot` 讀取。`supportsConfiguredThinkingControl()` 以 provider 名稱判斷。 | 要改為所有 Qwen 生成請求都明確送出。 |
| `shopping_assistant` | 模型設定讀取 `SHOPPING_ASSISTANT_MODEL`（未設定時用 Gateway 各用途模型）與 `SHOPPING_ASSISTANT_THINKING_ENABLED`（可為 true／false／未設定）。production graph 的 4 個呼叫點都傳入 `thinkingEnabled`。demo 啟動檢查要求值為字面上的 `"false"`。 | B12：任何模式都必須是關閉。 |
| `chatbot` | 呼叫時展開 `chatModelDefaults()`；非 demo 模式為空物件，所以不送 `enable_thinking`。 | 要改為 Gateway 預設。 |
| `deep_researcher` | 用 `research`、`vision` 等用途建立模型，不傳 thinking。 | 同上。 |
| `math_agent`、`mcp_agent` | 用 `math`、`tool` 用途，不傳 thinking。 | 同上；demo 不開放，但仍屬已註冊 graph。 |
| provider 層 fallback | `LLM_FALLBACK_ENABLED` 預設 `false`；fallback 單位是 provider，不是模型。已註冊 graph 都呼叫 `createChatModel`，不經過 `createChatModelWithFallback`。 | 不新增模型層 fallback。 |
| kb-eval CLI | 生成模型取 `KB_EVAL_GENERATION_MODEL` → `QWEN_CHAT_MODEL` → 寫死 `qwen-plus`。judge 取 `KB_EVAL_JUDGE_MODEL` → `qwen-max`。provenance 有 `generationModel` 與 `judgeModel`，沒有 thinking 與 endpoint。 | 要補 provenance；預設改用單一來源常數。 |
| chain-eval live | 模型取 `SHOPPING_ASSISTANT_MODEL`（live 模式必填）。建立模型時**沒有**傳入 `settings.thinkingEnabled`。provenance 有 `generationModel` 與 `temperature`。 | 要與 production 一致，並補 provenance。 |
| order-request golden | provenance 有 `model`。建立模型時沒有傳入 thinking。 | 同上。 |
| knowledge model gateway | 只處理 embedding 與 rerank。 | 不變。 |
| `.env.example` | 全部 `qwen-plus`、vision 為 `qwen-vl-plus`、`QWEN_BASE_URL` 為北京 endpoint；沒有 Gun Shop 與 thinking 相關設定。 | 要更新範例。 |

### 外部事實（標示驗證狀態）

| 事實 | 來源 | 狀態 |
|---|---|---|
| `qwen3.5-flash` 是混合思考模型，**thinking 預設開啟**；`enable_thinking=false` 時直接回答；reasoning token 以 output 單價計費。 | Alibaba Cloud Model Studio「Use deep thinking models via API」與 OpenAI Batch API 文件（2026-11-04 檢索）。 | 文件已確認；新加坡 endpoint 上的實際行為**未以 live 驗證**。 |
| 新加坡區提供 `qwen3.5-flash`，支援影像輸入與結構化輸出；單價 USD 0.1 in／0.4 out。 | r2 §4.1、§9（2026-10-27／28 檢索）。 | 文件已確認；單價待 6.4(a) 在 console 重新核實。 |
| 新加坡國際 endpoint（OpenAI-compatible）為 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`；API Key 依區域分開。 | Model Studio 國際站文件。 | **未以 live 驗證**；由 live probe 確認。 |
| Qwen 混合思考模型在 thinking 開啟時，可能不支援 `response_format: json_object`。 | Model Studio 結構化輸出文件的限制說明。 | **未驗證**；本 Change 預設關閉 thinking，所以不影響預設路徑。live probe 只驗證「關閉時可用」。 |
| `qwen3.5-flash` 支援 Tool Calling（OpenAI `tools`／`tool_choice`）。 | Model Studio function calling 文件。 | **未以 live 驗證**。 |
| `qwen-plus`／`qwen3.7-plus` 在 OpenAI-compatible 模式下接受 `enable_thinking=false`。 | Model Studio 文件。 | **未以 live 驗證**；只影響回滾路徑。 |

## Goals / Non-Goals

Goals 與 Non-goals 以 proposal 為準。設計限制：

- 不得依模型名稱改變 Domain Schema、Graph Edge 或業務邏輯（AGENTS.md §6、backend/AGENTS.md §6、§12）。
- 模型差異只透過設定與 provider capability 表達。
- embedding／rerank 不變。

## Decisions

### D-1：以「設定 + 單一來源程式預設」切換，不以 fallback 鏈切換

**做法**：

1. `.env.example` 把所有生成用途的範例值改為 `qwen3.5-flash`，包含 `QWEN_CHAT_MODEL`、`QWEN_RESEARCH_MODEL`、`QWEN_TOOL_MODEL`、`QWEN_VISION_MODEL`、`DEFAULT_MODEL`、`CHAT_MODEL`、`MATH_MODEL`、`MCP_AGENT_MODEL`，並新增 `SHOPPING_ASSISTANT_MODEL`、`KB_EVAL_GENERATION_MODEL` 的註解範例。
2. Gateway 中 Qwen 的程式預設（目前寫死在解析函式中的 `qwen-plus`、`qwen-vl-plus`）與 kb-eval CLI 的寫死 `qwen-plus`，改為引用同一個具型別的 Domain Constant「預設生成模型」，值為 `qwen3.5-flash`。vision 用途也用它：r2 §4.1 記載 qwen3.5-flash 在新加坡原生支援影像輸入，且新加坡沒有 `qwen3-vl-flash`。
3. 解析優先序不變：呼叫端指定 → purpose 專屬設定 → legacy 設定 → 程式預設。

**理由**：模型名稱只是設定值，不承擔業務判斷。回滾只需改設定。程式預設集中在單一常數，避免「設定都沒填時悄悄回到 qwen-plus」。

**替代方案**：

| 方案 | 不採用的理由 |
|---|---|
| A. 只改 `.env.example` 與部署設定，保留程式內的 `qwen-plus` 預設 | 沒有設定的環境（本機、測試、CI）會悄悄使用 `qwen-plus`。評測可能在不知情下用錯模型，provenance 也會跟著不一致。 |
| B. 以 provider 層 fallback 鏈切換（primary = flash，fallback = plus） | 現有 fallback 的單位是 provider，不是模型，要支援模型層 fallback 得新增機制。已註冊 graph 也都不經過 fallback 路徑。C1 的 fallback 模型尚未決定，現在加 fallback 等於替 1B-2 做決策。 |
| C. 依 graph 分別寫死模型 | 違反單一來源原則，回滾要改程式。 |

### D-2：thinking 由 Gateway 統一明確送出，預設 `false`

**做法**：

1. Provider capability 新增 `supportsThinkingControl`：`qwen` 為 `true`，`ccr`、`openai-compatible` 為 `false`。現有以 provider 名稱判斷的 `supportsConfiguredThinkingControl()` 改為讀這個 capability，對外行為不變。
2. 新增全站 thinking 預設設定 `LLM_THINKING_DEFAULT_ENABLED`（OD-2 已定案），只接受 `true`／`false`，未設定時為 `false`，格式錯誤時拒絕啟動。
3. 有效 thinking 的決定順序：呼叫端明確傳入的 `thinkingEnabled` → `configureChatModelDefaults` 設定的入口預設（demo 模式下 `chatbot` 的 `CHAT_THINKING_ENABLED`）→ 全站預設 → `false`。
4. provider 宣告 `supportsThinkingControl: true` 時，**每個**生成請求都送出明確的 `enable_thinking`，包含 vision、JSON object、Tool Calling 與修復重送。宣告 `false` 時永不送出；此時若設定明確要求開啟 thinking（全站預設或入口設定為 `true`），視為設定錯誤並拒絕啟動。
5. 實際送出的 thinking 值放進 `response_metadata`（例如 `thinking_enabled`），供 provenance 與 tracing 讀取。不新增 State 欄位。
6. `demo-cost-and-access-guard` 已提交的 `backend/src/platform/llm-gateway.usage.test.ts` 斷言「呼叫端未傳 thinking 時不送出 `enable_thinking`」，鎖定的是本 Change 要取代的舊行為。Master 2026-11-11 授權把該斷言更新為期望 `enable_thinking: false`；這是更新至新契約，不是放寬，該檔其他斷言（含帳本金額）不得修改。

**理由**：官方文件說 flash 預設開啟 thinking。若不由 Gateway 統一送出，`deep_researcher`、`math_agent`、`mcp_agent` 與非 demo 的 `chatbot` 會在切換後產生 reasoning token。放在 Gateway 可涵蓋所有呼叫點，各 graph 不必逐一修改，也不依模型名稱判斷。

**替代方案**：

| 方案 | 不採用的理由 |
|---|---|
| 各 graph 呼叫點逐一傳入 `thinkingEnabled: false` | 呼叫點多（`deep_researcher` 至少 5 處），容易漏；新增呼叫點時沒有保護；而且這些 graph 檔案正被 `demo-cost-and-access-guard` 修改。 |
| 依模型名稱判斷是否送出 `enable_thinking` | 違反禁止規則。 |
| 不送出，依賴 provider 預設 | flash 的預設是開啟，與 B12 衝突。 |

### D-3：Gun Shop thinking 一律關閉並在啟動時驗證

**做法**：Gun Shop 模型設定讀取時，`SHOPPING_ASSISTANT_THINKING_ENABLED` 只接受未設定或 `false`。未設定時有效值為 `false`，不交由全站預設決定，`true` 或其他值一律拒絕啟動（`invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED`）。此驗證在 backend 啟動與評測 CLI 讀取設定時都會執行，不限於 demo 模式。Gun Shop 設定讀取的回傳型別中，thinking 為必填 boolean，未設定時直接回傳 `false`，不回傳可選欄位。這樣任何呼叫點都不會把 undefined 傳給 Gateway 而落到全站預設（review-result-review-plan-003 Minor 1）。demo 模式額外要求字面值為 `false` 的既有檢查（`demo-cost-and-access-guard` 5.2）保持不變。

**理由**：B12 寫的是「Gun Shop 一律關閉」，不限 demo。評測和 production 共用同一份設定讀取，可確保量測與部署一致。

**相容性**：先前 `true` 可以接受，現在改為拒絕。目前沒有已知流程依賴 `true`。

### D-4：fallback 鏈語意

- 不新增模型層 fallback。
- provider 層 fallback 維持預設關閉，語意不變。若部署啟用 fallback，fallback provider 解析出的模型同樣適用 D-1 的優先序；demo 模式下必須在單價表中（由 `demo-cost-and-access-guard` 的既有檢查負責）。
- C1 的 fallback 模型（例如 flash 未通過時改用 `qwen3.7-plus` 或 `qwen3-vl-plus`）由 1B-2 決定；決定後只需改設定。

### D-5：評測 provenance 記錄實際模型

**做法**：kb-eval、chain-eval、order-request golden 的 provenance 新增下列欄位，舊欄位不變：

| 欄位 | 內容 |
|---|---|
| `generationModels` | 依生成用途列出設定解析後的模型，例如 `{ "chat": "qwen3.5-flash", "tool": "qwen3.5-flash" }`。 |
| `observedProviderModels` | 本次 run 中 provider 原始回報模型（`response_metadata.provider_model`，見 D-8）的去重集合，並附 `observedProviderModelsStatus`：`reported`（全部有回報）、`unreported`（全部沒有，集合為 `[]`）、`partial`（部分有）。 |
| `thinkingEnabled` | 本次 run 實際送出的有效 thinking 值；provider 不支援 thinking 控制時為 `null`。 |
| `llmProvider` | `qwen`／`ccr`／`openai-compatible`。 |
| `llmEndpointHost` | Gateway 實際使用之 endpoint 的主機名稱（D-9，含內建預設），不含路徑、query 與憑證，不得為空字串。 |

收集 `observedProviderModels` 的方式：評測自己的 invoker 包裝層讀取每次回應的 `response_metadata.provider_model`，**不讀** `response_metadata.model`（後者在 provider 未回報時由 Gateway 代填設定模型，無法分辨）。回應沒有 `provider_model` 欄位時視為該次未回報。包裝層放在評測模組內；Gateway 只依 D-8 新增欄位，不為評測改變既有回傳內容。

live chain-eval 與 order-request golden 建立模型時，必須傳入與 production graph 相同的 Gun Shop thinking 設定。

既有的 `generationModel`（單一字串）保留以維持相容。報表 Markdown 加一行模型摘要。

### D-6：新加坡 endpoint 相容性以 live probe 驗證，預設跳過

**做法**：新增手動觸發的 live probe（沿用既有 `RUN_QWEN_LIVE_SMOKE` 慣例，以新的獨立旗標 `RUN_QWEN_FLASH_PROBE=true` 啟用，預設跳過）。對設定中的 endpoint 與 `qwen3.5-flash` 各發一次最小請求，驗證：(a) 純文字；(b) `response_format: json_object` 並通過 Schema Validation；(c) Tool Calling 回傳可解析的 tool call；(d) vision（一張合成小圖）；(e) 送出 `enable_thinking=false` 時，回應的 usage 沒有 reasoning token，或 reasoning token 為 0。結果寫入 evidence，包含 endpoint 主機、模型、日期與每項結果，不含金鑰。

**限制**：probe 需要新加坡區 API Key（C4 國際帳號）。帳號未就緒時，probe 標示為未執行，對應 Requirement 標示為「文件已確認、live 未驗證」，不得宣稱通過。probe 會產生少量費用，由 Master 決定何時執行。

### D-7：endpoint 設定

`.env.example` 的 `QWEN_BASE_URL` 保留北京 endpoint（OD-3 已定案為 a），並加註新加坡 endpoint `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` 與「API Key 依區域分開」的說明。部署設定由 Chapter 2 D5 決定。

### D-8：Gateway 回應 metadata 新增 `provider_model`（apply-change-001 回報後新增）

**問題**：Gateway 組裝生成回應時，`response_metadata.model` 在 provider 未回報模型時以設定模型代填。評測包裝層因此無法分辨「provider 回報了與設定相同的模型」和「provider 沒有回報」，spec 的 `unreported` 無法端到端成立（implementation-result-apply-change-001 Blocker `PROVIDER_MODEL_ORIGIN_UNAVAILABLE`）。

**做法**：每個 provider adapter 的生成回應 metadata 新增 `provider_model: string | null`，只保存 provider 原始回報的非空模型名稱，否則為 `null`。既有 `model` 欄位與代填語意完全不變：模型欄位為字串時（含空字串）原樣保留，非字串或缺少時以設定模型代填（apply-change-003 發現空字串與 spec 舊文字矛盾，Master 2026-11-11 定案維持現行行為）。CCR（Anthropic Messages）adapter 目前回傳的生成回應完全沒有 `response_metadata`，本項必須補上 `provider`、`model`（依相同代填語意）與 `provider_model`，與 OpenAI-compatible 路徑對齊；provider envelope 的 Schema 可維持 passthrough，`model` 以 Runtime Validation 安全讀取，不使用 Type Assertion（review-result-review-plan-004 Minor 1）。重試、Tool 參數修復重送與 provider 層 fallback 都以最終被採用的那次 provider 回應為準。

**理由**：只新增欄位，Graph 輸出、帳本（`demo-cost-and-access-guard` 以 provider 與 `model` 入帳）與 tracing 讀到的值都不變。判斷依據是 provider 回應本身，不依模型名稱。

**替代方案**：

| 方案 | 不採用的理由 |
|---|---|
| 移除 `model` 的代填，未回報時改為 `undefined` | 改變既有 metadata 語意；帳本與 tracing 可能依賴 `model` 必有值，屬破壞性修改。 |
| 評測比對 `model` 是否等於設定值來推測 | 「回報值剛好等於設定值」與「代填」無法分辨，等同以設定值代填，違反 spec。 |
| 評測直接呼叫 provider HTTP 取得原始回應 | 繞過 Gateway，評測與 production 的請求路徑不一致。 |

### D-9：Gateway 提供有效 endpoint 主機的唯讀查詢（apply-change-001 回報後新增）

**問題**：未設定 `QWEN_BASE_URL` 時，Gateway 使用內建預設 endpoint，但沒有公開介面可取得它；評測只能記錄空的 `llmEndpointHost`（Blocker `DEFAULT_ENDPOINT_HOST_UNAVAILABLE`）。在評測端複製一份內建預設 URL 會形成第二個來源，違反單一來源原則。

**做法**：Gateway 新增唯讀查詢，回傳 `{ provider, endpointHost }`。`endpointHost` 由 Gateway 實際使用的 base URL（含內建預設）解析出主機名稱；無法解析時回報穩定的設定錯誤（不含設定值）；需要 base URL 但未設定的 provider 依既有缺少設定語意報錯。評測三條路徑（kb-eval、chain-eval、order-request golden）都改用此查詢，在建立模型前呼叫，失敗即中止。

**範圍限制**：不擴充既有 `describeLlmGatewayConfig()` 的回傳內容，也不加入對外 health／readiness 回應，避免擴大外部可見資訊。

### D-10：預設生成模型常數放在不重疊的新模組

D-1 的 Domain Constant 放在不與其他 Change 重疊的新模組（不放在 Gateway 檔案內），Gateway（2.1）與 kb-eval CLI（2.4）都引用它。這樣 2.4 不必等待 Gateway 檔案釋放。

## 檔案邊界與施工順序

### 與其他 Change 的檔案重疊

| 檔案或區域 | 其他持有者 | 本 Change 需要的修改 |
|---|---|---|
| LLM Gateway（`backend/src/platform/llm-gateway.ts`） | `demo-cost-and-access-guard`（未提交，READY_FOR_REVIEW）、`stream-chat-answer-text` | D-1 程式預設、D-2 capability 與 thinking 送出、D-8 `provider_model`、D-9 endpoint 唯讀查詢 |
| Gun Shop 模型設定（`backend/src/agents/shopping-assistant/model-settings.ts`） | `demo-cost-and-access-guard` | D-3 |
| backend 啟動組裝（`backend/src/application.ts`） | `demo-cost-and-access-guard` | 原則上不需修改；若 D-2 的全站預設需要在啟動時驗證，優先放在 runtime 設定讀取 |
| kb-eval CLI（`backend/src/knowledge/evaluation/evaluate.cli.ts`） | `harden-kb-evaluation-baseline`（2026-11-06 已歸檔並提交，檔案已釋放） | D-1 預設、D-5 provenance |
| 各 graph 檔案（`chatbot`、`deep-researcher`、`math-agent`、`mcp-agent`、`shopping-assistant/*`） | `demo-cost-and-access-guard` | **不修改**（D-2 在 Gateway 統一處理） |
| demo 啟動檢查（`backend/src/demo/**`）、usage／單價表（`backend/src/platform/usage/**`） | `demo-cost-and-access-guard` | **不修改** |

### `demo-cost-and-access-guard` 與本 Change 的邊界

- 6.4(c) 只要求本 Change「完成」，兩者沒有程式層的相依。
- 單價表、單價驗證、未定價模型拒絕啟動、帳本、准入，都屬於 `demo-cost-and-access-guard`。本 Change 不新增也不修改單價或單價表格式；測試若需要價格，使用該 Change 既有的 fixture，不填正式單價。
- demo 模式的 Gun Shop thinking 字面值檢查屬於 `demo-cost-and-access-guard`；本 Change 的 D-3 是任何模式都適用的通用驗證，兩者並存且不重複實作。
- 切換到 flash 後，demo 單價表必須含 `qwen3.5-flash`；這由 6.4(a) 處理。

### 施工分組

- **Group A（不與其他 Change 重疊，review-plan 通過後即可施工）**：`.env.example`、chain-eval 與 order-request golden 的 provenance 與 thinking 一致性（`backend/src/evaluation/commerce/**` 中與 provenance、live dependencies、golden CLI 相關的檔案）、評測 invoker 包裝層（新檔）、live probe（新檔）、新測試檔。
- **Group B（修改重疊檔案）**：Gateway（D-1、D-2、D-8、D-9）、Gun Shop 模型設定（D-3）、kb-eval CLI（D-1、D-5）。依 OD-1 (a)，Group B 要等下列條件成立才施工：該檔案上其他 Change 的修改已提交；`stream-chat-answer-text` 尚未開始修改 Gateway，或其修改已提交。兩個 Change 不得同時修改同一檔案。
- **Group C（依賴 Group B 的評測接線）**：評測包裝層改讀 `provider_model` 並支援 `partial`；三條評測路徑的 `llmEndpointHost` 改用 D-9 查詢。檔案不與其他 Change 重疊，但必須在 D-8、D-9 完成後施工。

**Gate 以檔案為單位（apply-change-001 回報後修訂）**：施工前，Codex 對每個 Group B task 只檢查該 task 要修改的檔案，以 `git status --porcelain` 與 `git diff --stat` 確認沒有其他 Change 未提交的修改。某個 task 的檔案不乾淨時，只跳過該 task 及依賴它的 task，其他 task 照常施工；不得與其他 Change 的未提交修改交錯，也不得 stash、reset 或 checkout 這些檔案。施工順序與相依：

| Task | 修改檔案 | 前置條件 |
|---|---|---|
| 2.1、2.2、2.5、2.6 | Gateway | Gateway 檔案乾淨 |
| 2.3 | Gun Shop 模型設定 | 該檔案乾淨 |
| 2.4 | kb-eval CLI、D-10 新模組 | kb-eval CLI 乾淨 |
| 2.7 | 評測模組（含 kb-eval CLI） | 2.4、2.5、2.6 完成 |

## 各層變更

### frontend

無變更。模型與 thinking 都是 backend 設定，frontend 不持有、不顯示模型憑證。

### bff

無變更。不新增 Route、錯誤碼或事件。

### backend

- LLM Gateway：程式預設改為引用單一常數（D-10）；新增 `supportsThinkingControl` capability；新增全站 thinking 預設設定；每個 Qwen 生成請求明確送出 `enable_thinking`；`response_metadata` 記錄實際送出的 thinking 值與 `provider_model`（D-8）；新增有效 endpoint 主機唯讀查詢（D-9）。
- Gun Shop 模型設定：thinking 只接受未設定或 `false`，未設定時有效值為 `false`。
- 評測：provenance 新增欄位；live 評測套用 Gun Shop thinking 設定；invoker 包裝層收集 provider 回報的模型。
- `.env.example`：範例值與說明。
- live probe：新檔，預設跳過。

## 安全與權限

- 不新增 Tool、MCP 或外部權限。
- provenance 與 evidence 只記錄 endpoint 主機名稱，不記錄完整 URL query、API Key、Authorization header 或完整回應內容。
- live probe 的合成影像不得包含個人資料；probe 不保存模型輸出全文，只保存結構化判定結果。
- 新加坡 endpoint 的 egress 沿用既有 provider 網路設定；本 Change 不修改 egress 政策。

## 可觀測性

- 既有 span 屬性 `model.name`、`model.provider` 不變；thinking 值透過 `response_metadata` 提供給 tracing。
- 帳本依 `demo-cost-and-access-guard` 逐次以 provider 與 model 入帳；本 Change 不修改帳本。

## Risks / Trade-offs

| 風險 | 緩解 |
|---|---|
| flash 品質不如 qwen3.7-plus，影響引用準確度、拒答與路由。 | 1B-2 以 C1 門檻驗收；未通過時依 1B-2 決定改設定或選 fallback 模型。履歷數字在 1B-7 前不替換。 |
| 明確送出 `enable_thinking=false` 後，`qwen-plus` 回滾路徑的行為改變。 | 依文件，`qwen-plus` 預設本來就是關閉；live probe 可另外對回滾模型執行一次（選做）。 |
| 新加坡 endpoint 的 JSON object 或 Tool Calling 與北京不同。 | live probe；未執行前標示未驗證。 |
| Group B 被其他 Change 卡住，延後 6.4(c)。 | OD-1 由 Master 決定順序；Group A 先完成。 |
| Gun Shop thinking 收緊後，有人依賴 `true`。 | 目前沒有已知流程；錯誤碼沿用既有值，訊息清楚。 |

## Master 決策紀錄（2026-11-04）

- **OD-1 檔案重疊的施工方式：(a)**。先施工 Group A；Group B 等 `demo-cost-and-access-guard` 的修改提交、且 `stream-chat-answer-text` 尚未開始修改 Gateway 或已提交後，再依序施工。兩個 Change 不會同時修改同一檔案，但同一檔案會先後被兩個 Change 修改。施工前由 tasks 0.3 檢查。
- **OD-2 全站 thinking 預設設定：`LLM_THINKING_DEFAULT_ENABLED`**，預設 `false`，只影響宣告 `supportsThinkingControl` 的 provider。
- **OD-3 `.env.example` 的 `QWEN_BASE_URL`：(a)**。保留北京並加註新加坡；部署設定在 D5 指定。

## Review 仲裁紀錄

review-result-review-plan-003（APPROVE，0 Blocker／0 Major）的兩個 Minor 都接受：

- Minor 1：Gun Shop 設定讀取的 thinking 改為必填 boolean，見 D-3、tasks 2.3。
- Minor 2：tasks 2.2 的「Schema 相同」以 spec「模型切換不改變 Domain Contract」Scenario 為基準。

## apply-change-001 仲裁紀錄（2026-11-07）

Codex 回報 partial（implementation-result-apply-change-001）。CCR 仲裁如下，經 Master 同意後寫入：

- **`GROUP_B_DIRTY_WORKTREE`**：維持 OD-1 (a)。Gateway 與 Gun Shop 模型設定仍有其他 Change 未提交的修改，相關 task 繼續等待。Gate 改為以檔案為單位，kb-eval CLI 已釋放，2.4 下一輪可施工。
- **`PROVIDER_MODEL_ORIGIN_UNAVAILABLE`**：屬 plan 遺漏的契約，不是施工錯誤。新增 D-8 與 tasks 2.5，評測接線移至 2.7。
- **`DEFAULT_ENDPOINT_HOST_UNAVAILABLE`**：同上。新增 D-9 與 tasks 2.6，評測接線移至 2.7。
- **3.1 的兩項既存失敗**：`runtime/tool-dispatch/pipeline.test.ts` 的錯誤碼不符，以及 `runtime/__tests__/integration.test.ts` 需要 PostgreSQL（`127.0.0.1:5433`）。兩者在不含本 Change 的隔離基準上都能重現，不屬本 Change，不修改其程式或 Assertion；3.1 以基準比對 evidence 判定。
- 1.2、1.3 已交付的部分保留；其中 `unreported`／`partial` 端到端與 endpoint 主機的驗收移至 2.7。

## review-plan-004 仲裁紀錄（2026-11-07）

review-result-review-plan-004（APPROVE，evidence gate 通過，0 Blocker／0 Major／2 Minor）。經 Master 同意後寫入：

- **Minor 1（接受）**：CCR adapter 的生成回應沒有 `response_metadata`。寫入 D-8 與 tasks 2.5，CCR 路徑必須補上 `provider`、`model` 與 `provider_model`。
- **Minor 2（接受，但修改建議做法）**：tasks 3.1 補上基準建立方式。Reviewer 建議的 `git stash` 違反「不得 stash、reset 或 checkout 他人修改」的範圍限制，不採用。改用不動到目前工作目錄的做法：以 `git worktree add` 在暫存目錄建立指定 commit 的獨立工作樹，或把基準檔案複製到暫存快照目錄（apply-change-001 的做法）。
- **剩餘風險（接受）**：tasks 3.4 在本輪修訂前勾選，修訂後尚未重跑 strict validate，因此取消勾選，由下一輪 Codex 重新驗證。

## 待決項（不屬本 Change）

- **C1（屬 1B-2）**：flash 的品質門檻（引用、拒答）與未通過時的 fallback 模型。

## Migration Plan

1. Group A：`.env.example`、評測 provenance、live probe、測試（apply-change-001 已交付）。
2. Group B（依 OD-1，以檔案為單位的 Gate）：kb-eval CLI 與 D-10 常數模組可先施工；Gateway（含 D-8、D-9）與 Gun Shop 設定等檔案釋放。
3. Group C：評測接線改用 D-8、D-9。
4. 執行 backend lint、test、build。
5. （Master 決定時機）以新加坡帳號執行 live probe，保存 evidence。
6. 交給 1B-2：以 flash 重跑評測並套用 C1。

回滾：見 proposal「回滾策略」。
