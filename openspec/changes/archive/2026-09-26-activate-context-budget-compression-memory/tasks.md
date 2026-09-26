# Tasks：activate-context-budget-compression-memory

> 每個 Task 可獨立驗證。本 Change 僅落在 `backend`。驗證命令以 `backend` 既有 script 為主（lint／test／build）。Codex 不得勾選未實際執行或未通過的驗證；live 驗證與 fault injection 如無法完成須如實標記未驗證項。

## T1 建立 Context source 契約與 priority 映射（backend）

> 無前置依賴（沿用 X7 既有 `ContextPriority`／`ContextItem`）。

- [x] 新增 `src/context/context-source.ts`：定義有型別 `AgentContextSource`（`system_policy`、`current_task`、`active_state`、`memory`、`recent_messages`、`tool_output`）與 `priorityForSource()`，單一來源映射至 P0–P5；unknown source 回明確 mapping error。
- [x] 定義 `ContextSection`（source＋content＋referenceId）與 `toContextItem()`；不引入 `any`，外部輸入 runtime validate。
- [x] 新增 test：六種 source 各自映射正確、unknown source 拋錯、priority 契約（P1 > P3）有 contract test 覆蓋。

驗證命令：

```bash
cd backend
npm run test -- src/context/context-source.test.ts
npm run lint
```

## T2 擴充 provider capability 的 context window（backend）

> 依賴：T1。

- [x] 於 `src/platform/llm-gateway.ts` 的 `LlmCapabilities` 增加 `contextWindowTokens: number` 與 `maxOutputTokens: number`，由 `capabilitiesForProvider(provider, purpose)` 單一來源產出；不因 model-name substring 分支。
- [x] 於 `src/platform/runtime-config.ts` 增加 `contextOutputReserveTokens`（env `AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS`，預設 `4096`）。
- [x] 新增 `resolveEffectiveContextLimit(config, capabilities)`：`outputReserve = max(contextOutputReserveTokens, maxOutputTokens)`；回 `min(contextBudgetTotal, contextWindowTokens − outputReserve)`；`contextWindowTokens` 未知→採 `contextBudgetTotal` 並回 `provider_window_unknown`；`outputReserve ≥ contextWindowTokens` → 回 `context_config_invalid` terminal。
- [x] 新增 test：window 小於 budget 取 window、budget 較小取 budget、outputReserve 取較大值、unknown window 回 fallback、reserve ≥ window fail-closed、無 model-name 分支（architecture/contract test）。

驗證命令：

```bash
cd backend
npm run test -- src/platform/llm-gateway.context-limit.test.ts
npm run build
```

## T3 建立 shared Context assembly boundary（backend）

> 依賴：T1、T2、X12、X17。

- [x] 新增 `src/context/agent-context-assembler.ts`：`buildAgentContext({ executionContext, sources, memoryProvider, limits, signal })` → `AssembledContext`（text、blocks、totalTokens、truncatedBlocks、exceeded、manifest）。
- [x] 依 priority 組 blocks → `allocateBudget` → P0 overflow 檢查（`context_p0_overflow`）→ 超限時 `compressBlocks`（僅 P5/P4）→ 依 P5→P4→P3→P2 整塊丟棄；丟棄後 P0+P1 仍超限 → `context_hard_limit_overflow`；`exceeded` 為 terminal signal。
- [x] 拋出 typed `ContextHardLimitError`（code 為上述 reason code）；壓縮失敗／逾時／取消 → 丟棄壓縮輸出、走同一 fallback；estimator 不可用 → byte-based estimate＋reason code。
- [x] 新增 test：正常範圍、非 P0 超限壓縮與依序丟棄（含 P3/P2）、P0 超限 terminal、P0+P1 超限 terminal、`exceeded` 語意、壓縮失敗 fallback、取消中止、多語／emoji／大型 Tool output 不超限。

驗證命令：

```bash
cd backend
npm run test -- src/context/agent-context-assembler.test.ts
npm run build
```

## T4 建立 Memory composition root 並接線 recall（backend）

> 依賴：T1、X10.1、X12。

- [x] 新增 `src/platform/memory-composition.ts`：依 feature flag 建構並快取 `MemoryGovernanceService`＋`MemoryContextProvider`（store adapter、authorizer、write policy、relevance config）；建構失敗→回「無 Memory」降級並 emit degraded event。
- [x] 於 shared boundary 接線 recall：以 X12 `principal`／`scope` 呼叫 `MemoryContextProvider.recall`，結果注入 P3；`budgetHint` 由 P3 預留。
- [x] 新增 test：授權 Memory 注入 P3、未授權／跨 tenant 不注入、store 不可用降級＋degraded event、recall 逾時、現行輸入覆蓋衝突 Memory。

驗證命令：

```bash
cd backend
npm run test -- src/platform/memory-composition.test.ts
npm run lint
npm run build
```

## T5 建立 redacted Context manifest 與可觀測性（backend）

> 依賴：T3。

- [x] 新增 `src/context/context-manifest.ts`：`ContextManifest` 型別＋`buildContextManifest()`＋遮罩規則（不含原始 message／Memory value／未遮罩 PII／credential）；P3 memory 區塊的 `referenceId` 一律為 `memoryId`（不含 value）。
- [x] 組裝器 emit `auditLogger.record("context.manifest", …)` 與 trace attributes；含 policyVersion、compressionAction、reasonCode、p0Tokens、totalTokens、effectiveLimit、sourceRefs。
- [x] 新增 test：manifest 欄位齊全、遮罩不洩漏（含 memory referenceId 不含 value）、compression action 各態、degraded 與 terminal reason code 正確。

驗證命令：

```bash
cd backend
npm run test -- src/context/context-manifest.test.ts
npm run lint
```

## T6 遷移 chatbot 至 shared boundary（backend）

> 依賴：T3、T4、T5。

- [x] `src/agents/chatbot.ts`：以 `buildAgentContext` 取代 `buildConversationContext`＋`getLatestUserMessage`；system prompt 入 P0、現行輸入入 P1、recent messages 入 P4；移除 production 對 deprecated helper 的呼叫。
- [x] 保留 `buildConversationContext` 為 deprecated compatibility helper（不在此刪除），但 production Agent 不再呼叫。
- [x] 新增 test：chatbot 組裝經 shared boundary、輸入有界、多輪不超限、Memory 注入、現行輸入優先。

驗證命令：

```bash
cd backend
npm run test -- src/agents/chatbot.context.test.ts
npm run lint
npm run build
```

## T7 遷移 math-agent 至 shared boundary（backend）

> 依賴：T3、T4、T5。

- [x] `src/agents/math-agent.ts`：以 `buildAgentContext` 取代只取最新一則；system 入 P0、現行入 P1、recent 入 P4、tool result 入 P5；不改變 calculator dispatch 路徑。
- [x] 新增 test：math 組裝經 shared boundary、multi-turn 承接、tool result 依序壓縮／丟棄、現有 math 回歸通過。

驗證命令：

```bash
cd backend
npm run test -- src/agents/math-agent.test.ts
npm run test -- src/agents/math-agent.context.test.ts
npm run build
```

## T8 遷移 mcp-agent 至 shared boundary（backend）

> 依賴：T3、T4、T5。

- [x] `src/agents/mcp-agent.ts`：以 `buildAgentContext` 產出 bounded message list 取代 `[...state.messages]`；tool-calling system message 入 P0、tool output 入 P5。
- [x] 定義 bounded message list 契約：保留 system／user／assistant／tool 角色邊界，且 tool message MUST 緊跟帶相同 `tool_call_id` 的 assistant message；截斷／丟棄 MUST NOT 拆散 assistant tool_call 與其 tool result 配對。
- [x] 新增 test：有界、tool output 壓縮／丟棄、tool_call/tool message 配對完整、既有 mcp tool-calling 回歸通過。

驗證命令：

```bash
cd backend
npm run test -- src/agents/mcp-agent.tool-calling.test.ts
npm run test -- src/agents/mcp-agent.context.test.ts
npm run build
```

## T9 遷移 deep-researcher 至 shared boundary（backend）

> 依賴：T3、T4、T5。

- [x] `src/agents/deep-researcher.ts`：`buildImAgentContextPack` 的產出作為 P2 active state 來源，交由 `buildAgentContext` 統一做預算／壓縮／Memory。
- [x] Memory 以獨立 prompt 段落注入 planner／synthesis（不回寫 `state.contextPack`／`ImAgentContextPack`），不破壞既有 state flow；planner／synthesis prompt 注入 P3 Memory。
- [x] 保持 weather／calculation／research 路由與既有 golden case 不變；新增 test：context pack 有界、Memory 注入 planner（獨立段落、不改 contextPack）、大型 fetch 內容（P5）不超限、既有 weather 回歸通過。

驗證命令：

```bash
cd backend
npm run test -- src/agents/deep-researcher.query-workflow.test.ts
npm run test -- src/agents/deep-researcher.weather.test.ts
npm run test -- src/agents/deep-researcher.context.test.ts
npm run build
```

## T10 全量回歸與驗證收斂（backend）

> 依賴：T6–T9。

- [x] 執行 backend 全量 lint／test／build；確認無 deprecated last-N／無界 history 殘留（architecture test）。
- [x] 以 fault injection 驗證 P0 overflow、Memory 不可用、compression 失敗、取消四條失敗路徑皆收斂且可觀察；無法執行的 live 驗證如實標記。
- [x] 確認 Git Diff 無無關修改；`tasks.md` 只勾選真正完成且驗證的工作。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```
