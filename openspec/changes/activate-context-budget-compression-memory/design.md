# Design：activate-context-budget-compression-memory

## 1. 責任邊界

本 Change 只在 `backend` 建立「單一生產語境組裝邊界」，把既有 Context framework 與 Memory governance 接線到四個 Agent。不觸碰 BFF 與 frontend 的傳輸／事件／顯示契約。

```text
Browser → BFF → LangGraph Agent Server
                     │
                     ▼
          shared Context Assembly Boundary
                     │
   ┌──────────────┬──┴──────────┬───────────────┐
   │ Context       │ Compression │ Memory        │
   │ budget/prio   │ (existing)  │ governance    │
   └──────────────┴─────────────┴───────────────┘
                     │
        provider capability (context window)
```

- **frontend**：無變更。Context manifest 不是使用者可見事件，不做 UI 承接。
- **bff**：無變更。Trusted identity 已在 X12/X13 由 BFF 解析，此處只消費 canonical ExecutionContext。
- **backend**：新增 shared 組裝器與 Memory composition root，擴充 `LlmCapabilities`，遷移四個 Agent。

## 2. 資料流

```text
ExecutionContext (X12) + NormalizedAgentInput (X17)
   → buildAgentContext(sources, limits, signal)
       1. resolve effective hard limit = min(contextBudgetTotal,
              provider.contextWindowTokens - outputReserve)
       2. recall authorized Memory (P3) via MemoryContextProvider
       3. build ContextItem[]:
            P0 system policy / security rules
            P1 current task (normalized input / current message)
            P2 active state (plan / task context, 若 Agent 有)
            P3 authorized memory
            P4 recent conversation messages
            P5 tool output
       4. allocateBudget (priority-first, P0 全納)
       5. if exceeded → compressBlocks (P5→P4→drop) → deterministic fallback
       6. emit redacted ContextManifest (audit/trace)
   → AssembledContext { text, blocks, totalTokens, truncatedBlocks, exceeded }
```

Agent 端把 `AssembledContext.text`（或結構化 blocks）組進 model 呼叫：string 型 Prompt 走 text；message 型（如 `mcp-agent` 的 tool-calling）走 bounded message list。

## 3. Context item 契約與 priority

定義有型別、單一來源的 `AgentContextSource`，統一映射：

| Priority | 來源 | 範例 | 丟棄／壓縮行為 |
|---|---|---|---|
| P0 | system policy / security rules | 系統 prompt、安全規則 | 永不丟棄（超限→terminal error） |
| P1 | current task | normalized input／現行 user message | 永不丟棄 |
| P2 | active state | research plan／task 狀態 | 最後才丟（P3/P4/P5 之後） |
| P3 | authorized memory | 已授權 long-term memory | P4/P5 之後丟 |
| P4 | recent messages | 多輪 conversation | 可壓縮（截斷），P5 之後丟 |
| P5 | tool output | web_fetch、weather、calculator 結果 | 最先壓縮／丟棄 |

**完整丟棄順序（由先到後）＝ P5 → P4 → P3 → P2；P0／P1 永不丟棄。** 壓縮（lossy truncation）僅作用於 P5（tool output）與 P4（recent messages）；P2（active state）與 P3（memory）不壓縮、只整塊保留或丟棄，避免破壞結構化資料。

現行明確輸入（P1）永遠優先於歷史 Memory（P3）與推論。

## 4. 硬上限與 P0 invariant

沿用 `context-budget.ts` 的既有 priority-first 語意，並對外文件化唯一的超限契約：

- **P0 在 total hard limit 內**（無獨立 reserved limit）。`allocateBudget` 已把 P0 全數納入並以 `exceeded = p0Tokens > totalTokenBudget` 標記。
- **`AssembledContext.exceeded` 是 terminal signal，不是 warning**：組裝器在完成壓縮與丟棄後，若保留內容（P0＋P1，以及未丟棄的 P2–P5）仍超過有效硬上限，即設 `exceeded = true`，MUST NOT 呼叫模型，並回傳 terminal configuration error。
- 兩個 terminal 條件與 reason code：
  - `p0Tokens > effectiveLimit` → `context_p0_overflow`（P0 單獨即超限）。
  - 完整丟棄 P5→P4→P3→P2 後 `p0Tokens + p1Tokens > effectiveLimit` → `context_hard_limit_overflow`（P0＋P1 仍超限）。
- 非 terminal 的超限 → 依 §5 先壓縮、再依 §3 完整順序丟棄 P5→P4→P3→P2，保留 P0／P1；最終總量不超過有效硬上限。

有效硬上限 = `min(contextBudgetTotal, provider.contextWindowTokens − outputReserve)`。`outputReserve` 定義見 §7。

### 錯誤傳播（context overflow → frontend）

terminal configuration error MUST 走既有 error envelope 鏈，任一 Agent 不得以不同方式吞掉或改寫：

```text
buildAgentContext 拋出 ContextHardLimitError（code: context_p0_overflow / context_hard_limit_overflow）
  → Agent node try/catch → createErrorEnvelope(error, { source: "backend", stage: "context_assembly", executionContext })
  → serializeErrorEnvelope → AIMessage（terminal 內容）
  → applyInteractionGovernance 標記 terminal 並 emit terminal event（既有行為，不新增節點）
  → BFF 透傳（無變更）
  → frontend 以既有 error envelope 降級渲染（無變更）
```

不引入新的跨層 event 型別；`stage` 固定為 `context_assembly`，error code 即上面兩個 reason code。

## 5. 壓縮與 deterministic fallback

- 預算不足時先呼叫 `compressBlocks`（`DefaultCompressionStrategy`：P5 截斷→P4 截斷→丟 P5→丟 P4）。壓縮為 lossy truncation，僅作用於 P5／P4；P2／P3 不壓縮。
- 壓縮後仍超限 → 依完整順序整塊丟棄 P5 → P4 → P3 → P2（保留 P0／P1），直到總量 ≤ 有效硬上限。
- 壓縮失敗／逾時／取消時：**不採信壓縮輸出**，直接走同一 deterministic truncation（整塊丟棄 P5→P4→P3→P2），並在 manifest 標記 `compressionAction: "fallback_truncate"` 與 reason code。
- Token estimator 不可用時：採保守 byte-based estimate（`Math.ceil(byteLength/4)`，現有 `estimateTokens`），並標記 reason code（estimator unavailable）。

## 6. Memory injection 與失敗降級

- 以 `MemoryContextProvider.recall` 召回 authorized、visible、同 tenant/scope 的 Memory，注入 P3。
- recall 輸入的 `principal`／`scope` 來自 X12 `ExecutionContext`；`budgetHint` 來自 P3 預留。
- Memory store 不可用／逾時：`MemoryGovernanceService.recall` 已回空陣列並 emit `recall_degraded`；組裝器在 policy 允許時**繼續無 Memory 組裝**並 emit degraded context event（reason code `memory_unavailable`／`memory_timeout`）。
- 低信心推論 Memory 不得提升為硬約束；現行明確輸入覆蓋衝突 Memory（P1 > P3）。

## 7. Provider/model capability（context window）

- 擴充 `LlmCapabilities` 增加 `contextWindowTokens: number` 與 `maxOutputTokens: number`（模型最大輸出）。
- 來源為 capability 設定（per provider／endpoint kind），**不**在 domain logic 用 model-name substring 分支；`capabilitiesForProvider(provider, purpose)` 為單一來源，unknown provider/model 走保守預設並標記 reason code。
- `AgentRuntimeConfig` 增加 `contextOutputReserveTokens`（env `AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS`，預設 `4096`）作為操作者可調的輸出保留額度。
- `outputReserve = max(contextOutputReserveTokens, LlmCapabilities.maxOutputTokens)`；`maxOutputTokens` 未知時視為 `0`。
- 有效硬上限 = `min(contextBudgetTotal, contextWindowTokens − outputReserve)`；若 `contextWindowTokens` 未知，則以 `contextBudgetTotal` 為上限並標記 `provider_window_unknown`；若 `outputReserve ≥ contextWindowTokens`（組態錯誤），fail-closed 回 `context_config_invalid` terminal error。

## 8. Memory composition root（backend）

新增 production composition root（例如 `src/platform/memory-composition.ts`），依 feature flag 建構並快取：

```text
MemoryStorePort（InMemory 預設；Postgres 於 env 啟用）
  + MemoryAuthorizer（runtime/authorization）
  + MemoryWritePolicy + MemoryRelevanceConfig
  + referenceResolver / decisionRecorder（optional）
  → MemoryGovernanceService → MemoryContextProvider
```

- 未接線／建構失敗 → 依 policy 降級為「無 Memory」並 emit degraded event；不得阻斷 Agent。
- 本 Change 只接線 recall（讀取）；memory write 的 production 觸發點不在 X18 範圍（既有 write 能力已存在，但不在此啟用）。

## 9. Agent 遷移方式

- **chatbot**：`buildConversationContext`＋`getLatestUserMessage` → shared boundary；system prompt 入 P0，現行 user message 入 P1，recent messages 入 P4。
- **math-agent**：最新一則 → shared boundary（P0 system、P1 現行、P3 memory、P4 recent、P5 tool result）；不改變 calculator tool dispatch 路徑。
- **mcp-agent**：`[...state.messages]` → shared boundary 產出 bounded message list；tool-calling system message 入 P0；tool output 入 P5。bounded message list 契約：保留 system／user／assistant／tool 角色邊界，且 tool message MUST 緊跟帶相同 `tool_call_id` 的 assistant message；截斷／丟棄 MUST NOT 拆散 assistant tool_call 與其 tool result 配對。
- **deep-researcher**：`buildImAgentContextPack` 的 context pack → 由 shared boundary 承接（保留 `ImAgentContextPack` 型別作為 P2 active state 的來源，但預算／壓縮／Memory 統一走 shared boundary）。Memory 以獨立 prompt 段落注入 planner／synthesis（不回寫 `state.contextPack`／`ImAgentContextPack`），不破壞既有 state flow。

## 10. 可觀測性（Context manifest）

`ContextManifest`（redacted）包含：

```text
schemaVersion / policyVersion
sourceRefs: { priority, kind, referenceId, estimatedTokens }
totalTokens / effectiveLimit / p0Tokens
compressionAction: "none" | "compressed" | "fallback_truncate"
reasonCode（可選）：context_p0_overflow | context_hard_limit_overflow | context_config_invalid
  | provider_window_unknown | memory_unavailable | memory_timeout
  | compression_invalid | estimator_unavailable
```

P3 memory 區塊的 `referenceId` 一律為 `memoryId`（不含 value）。經 `auditLogger.record("context.manifest", …)` 與 trace attributes 輸出；不含原始 message、Memory value 或未遮罩 PII。

## 11. 替代方案與取捨

| 方案 | 取捨 |
|---|---|
| 直接逐 Agent 內嵌 budget/壓縮呼叫 | 快速但重複、易漂移，違反 X18「shared boundary」目標 → 不採 |
| 重寫 `ImAgentContextPack` 取代 Context framework | 破壞既有 X7 投資與測試 → 不採，改以 adapter 收斂 |
| 於 model-name 分支設定 context window | 違反根／backend AGENTS.md 禁止硬映射 → 不採，改 capability 設定 |
| Memory write 一併在本 Change 啟用 | 擴大範圍、涉 side-effect 治理 → 本 Change 只接 recall，write 另議 |
