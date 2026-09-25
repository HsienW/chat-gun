# Proposal：activate-context-budget-compression-memory

> 對應 Second Stage v4 的 X18。層級 Layer 6 — Harness, Context, and Stream Contracts。
> Labels：`second-stage`、`runtime-integration`、`layer-6`、`backend`、`reliability`
> Dependencies：X7（Context Budget）、X10.1（Long-term Memory Governance）、X12（Canonical ExecutionContext）、X17（Normalized Input + Query Guard）——均已 archive。

## 1. 問題描述

Chat-Gun 已經具備獨立、可測試的 Context framework（`ContextPriority` P0–P5、`allocateBudget`、`DefaultCompressionStrategy`）與 Memory governance（`MemoryGovernanceService`、`MemoryContextProvider`），但生產路徑上的四個 Agent 全都沒有消費它們：

| Agent | 目前的 Context 組裝 | 缺口 |
|---|---|---|
| `chatbot` | `buildConversationContext`（已標 `@deprecated`，`.slice(-10)`）＋`getLatestUserMessage` | 固定 last-N；無 priority、無硬上限、無壓縮、無 Memory |
| `math-agent` | 只取最新一則 human message | 無 multi-turn 承接、無 Memory（例如使用者的偏好或慣用單位） |
| `mcp-agent` | `[...state.messages]` 全量傳入模型 | 無界歷史，可能超出模型 context window；無壓縮、無 Memory |
| `deep-researcher` | 自成一派 `buildImAgentContextPack`（`recentMessageLimit:10`＋自己的 token 估計） | 與 Context framework 重複；無 Memory injection |

此外，`LlmCapabilities` 沒有 context window 大小，`AgentRuntimeConfig.contextBudgetTotal`（預設 128000）雖已存在但沒有 Agent 消費。結果是：模型輸入既可能無界成長而超限，也可能因為固定 last-N 而丟失跨輪上下文或授權 Memory。這與 Evidence Baseline 的「Context：Budget、priority、compression、memory-governance modules exist，但現有 Agents 仍用 legacy 或 unbounded 的 context 組裝路徑」完全一致。

本 Change 不是再造一套 Runtime，而是把既有 primitives 組裝成**單一生產語境組裝邊界**，並讓四個 Agent 全數遷移上去。

## 2. 解決方案

建立一個 shared Context assembly boundary，讓所有 Agent 依統一 priority 契約組裝模型輸入：

1. **單一 Context item 契約**：把「system policy／security rules（P0）、current task（P1）、active state（P2）、authorized memory（P3）、recent messages（P4）、Tool output（P5）」映射成有型別、可驗證的 `ContextItem` 來源。
2. **共享組裝器**：一個函式／service 接收 ExecutionContext（X12）、NormalizedAgentInput（X17）、messages、Tool output 與 Memory provider，產出 `AssembledContext` 與 redacted `ContextManifest`。
3. **硬上限與 P0 invariant**：P0 在 total hard limit 內；若 P0 單獨超過硬上限，回傳明確 terminal／configuration error，絕不送出超限請求。
4. **先壓縮、後丟棄**：預算不足時先執行已設定的 compression，再依 priority 丟棄可棄之低優先區塊；壓縮失敗／逾時／取消時走 deterministic truncation fallback。
5. **受管 Memory injection**：僅召回已授權、可見、同 namespace 的 Memory，注入 P3；現行明確輸入（P1）永遠優先於歷史 Memory 與推論。
6. **Provider/model capability 驅動真實上限**：在 capability 設定中提供 context window 大小（不分層於 model-name substring）；有效硬上限 = min(configured budget, provider context window − output reserve)。
7. **Redacted Context manifest**：輸出 source reference、priority、estimated tokens、compression action、policy version，供 audit／trace 觀察，不含原始敏感內容。
8. **Agent 遷移**：chatbot、math-agent、mcp-agent、deep-researcher 全數改走 shared boundary；移除或標記 deprecated 的 `buildConversationContext` 使用。

## 3. 受影響範圍

- **套件**：僅 `backend`。
- **能力域**：Context assembly、compression、memory governance、model provider capability、observability。
- **既有模組（只新增 adapter／composition，不重寫）**：
  - `src/context/*`（budget、compression、assembler）
  - `src/memory/*`（governance、context-provider、store）
  - `src/runtime/execution-context/*`（X12 ExecutionContext）
  - `src/runtime/input/*`（X17 NormalizedAgentInput，若已接線）
  - `src/platform/llm-gateway.ts`（`LlmCapabilities` 增加 context window）
  - `src/platform/runtime-config.ts`（`contextBudgetTotal` 已有）
- **Agent**：`src/agents/chatbot.ts`、`src/agents/math-agent.ts`、`src/agents/mcp-agent.ts`、`src/agents/deep-researcher.ts`。

## 4. 目標（In Scope）

- 四個 Agent 不再使用固定 last-N 或無界 history。
- 產生的模型輸入保持在有效硬上限內。
- Security／current-task 內容遵循已核准的保留政策。
- Tool result 與 conversation 依文件化順序壓縮／丟棄。
- 現行明確意圖覆蓋衝突 Memory。
- Memory 與 compression 的失敗路徑仍可用且可觀察。
- 覆蓋繁體中文、英文、中英混雜、emoji 與大型 Tool output 案例。

## 5. 非目標（Out of Scope）

- ❌ 不引入第二套通用 Run Runtime 或佇列。
- ❌ 不變更 BFF／frontend 的既有 Route、事件語意或使用者可見標籤（X19 才處理事件 envelope 版本化）。
- ❌ 不實作新的 Memory 儲存或新的壓縮演算法（沿用既有 `DefaultCompressionStrategy` 與 store adapter，除非壓縮為明確新增能力）。
- ❌ 不把完整 conversation 原始樣本當作 Memory 持久化。
- ❌ 不以 model-name substring 分支決定 context limit 或 Domain Schema。
- ❌ 不做 X20（durable HITL／crash-safe recovery）或 X21（production readiness gate）的整合。

## 6. 風險與回滾策略

| 風險 | 影響 | 緩解 |
|---|---|---|
| 共享組裝器引入後，Agent 回應品質因壓縮／丟棄而回歸 | 使用者體驗下降 | 以既有 golden case 與四語言／大 Tool output 案例回歸；compression 只作用於可棄區塊（P4/P5）；P0/P1 保留 |
| Memory 接線後注入不當資料 | 洩漏或污染語境 | 沿用 `MemoryGovernanceService` 的 namespace／authorizer 邊界；僅 recall 已授權、visible、同 tenant 的 record |
| provider context window 設定錯誤導致低估/高估 | 超限或浪費 | 有效上限 = min(budget, provider window − output reserve)；capability 單一來源、有 unknown 值處理與測試 |
| P0 超限進入 terminal 後無法降級 | 使用者卡住 | 明確 terminal error＋config error code，可被 frontend 安全降級（現有 error envelope 承接） |
| 四個 Agent 遷移範圍大 | 回歸風險 | 逐 Agent、可獨立驗證的 tasks；feature flag 可在必要時逐 Agent 回滾至 legacy 組裝 |

回滾：以 per-agent feature flag 控制是否走 shared boundary（以 `getBooleanEnv()` 讀取、預設 `true`），個別 Agent 可關閉回退至現有組裝，不動資料庫歷史：`CONTEXT_ASSEMBLY_ENABLED_CHATBOT`、`CONTEXT_ASSEMBLY_ENABLED_MATH`、`CONTEXT_ASSEMBLY_ENABLED_MCP`、`CONTEXT_ASSEMBLY_ENABLED_DEEP_RESEARCHER`。

## 7. 相容性

- 既有 Graph ID、BFF route、錯誤碼語意不變。
- 既有 event 型別不變；Context manifest 以 audit／trace 事件新增（不改變使用者可見 event contract）。
- `buildConversationContext` 保留為 deprecated compatibility helper，但生產 Agent 不再呼叫。
- Memory store 未接線時，policy 允許降級為「無 Memory 繼續」並 emit degraded event（見 design）。
