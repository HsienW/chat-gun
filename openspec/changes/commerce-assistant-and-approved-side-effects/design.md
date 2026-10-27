# Design：commerce-assistant-and-approved-side-effects

## 1. 文件 Profile 決策（ADR-FL-001）

本 Change 採 OpenSpec **lite** profile，決策來源為 `second-stage-plan-en-v6.md` 的 ADR-FL-001，依 `second-stage-plan-en-v7.md` 執行。X42 design §1 已收錄 ADR 全文，本節只列本 Change 的適用結果。

- **lite 仍包含**（本文件對應章節）：tool／agent 契約（§5、§6）、事件族與版本（§8）、成功／拒絕／對抗 Scenario（delta specs）、typed failure taxonomy（§9）、每個副作用的 idempotency 聲明（§6.3）、每項儲存產物的資料分級（§10）。
- **本 Change 延後項目**（記入 §14 Retrofit Debt）：營運 runbook、正式環境 store migration 計畫、compatibility matrix（X29）、reconciliation worker（X31）、操作歷史 projection（X30）。
- **不得放寬**：v6 十條 Non-Waivable Invariants 與 v7 第 11 條（Declared absence is not readiness）。

## 2. D0 唯讀核對紀錄（2026-10-23，plan-change 階段）

核對對象為目前分支（`master` + X42 的 11 個本地 commit）。X42 未修改下列 runtime 元件，結論對 `master` 同樣成立；apply-change T0 必須再以 `master` 實際比對一次並記錄。

| 假設 | 結論 | 證據（唯讀） | 對設計的影響 |
|---|---|---|---|
| confirmation interrupt 可由新 graph 呼叫 | **成立**。`createToolAuthorizationGraphNodes` 以 tools、confirmation store、interrupt manifest repository 與 execution manifest 為參數，產生 gate／confirmation／dispatch 三個節點與三個 route 函式；`mcp_agent` 即以此組裝 | `runtime/authorization/confirmation-graph.ts`、`agents/mcp-agent.ts` | `shopping_assistant` 以相同方式組裝，execution manifest 使用自己的 graphId |
| 審批由 X20 durable 狀態支撐 | **成立**。gate 先 `upsertPending` 審批描述並建立 interrupt manifest；resume 以一次性 `consume` 消費，逾期回傳 `CONFIRMATION_TIMEOUT` 並把 manifest 轉為 `expired` | 同上、`confirmation.ts`、migration 018／019 | 沿用；不新增審批儲存 |
| `kb_search` 經 X14 dispatch | **條件成立**。`kb_search` 經 X27 SDK adapter staged 後進入 descriptor registry；只有 graph 來源在 `PIPELINE_FLAG_BY_SOURCE` 有登錄且 flag 為 true 時才建立 dispatch pipeline，否則走預設 executor | `tools/registry.ts`、`tools/sdk/kb-search-manifest-adapter.ts` | `shopping_assistant` MUST 強制建立 pipeline，不得依 flag 退回（§5.4） |
| 副作用基礎設施 | **已存在**。business effect ledger（`(tenant, scope, businessEffectKey)` 唯一）、replay key、ToolExecutionRunner、descriptor reconciler、`SideEffectToolDescriptor.deriveBusinessEffectKey` | `runtime/side-effect/*` | 重用；不另建 ledger |
| 去重可觀察 | **不成立**。runner 重用已提交結果時回傳 `source: "cache"`，pipeline 映射為一般 `succeeded` 並捨棄 source；並行重複提交得到 `SIDE_EFFECT_CLAIM_NOT_ACQUIRED`，映射為 `rejected_before_dispatch` | `tool-dispatch/pipeline.ts` 的 runner 結果映射、`side-effect/tool-execution-runner.ts` | 新增 Requirement（§6.5、`side-effect-tool-execution-runtime` delta）；第 8 版確認需在 harness 契約新增去重結果類型（S7，§6.12） |
| 拒絕與取消可區分 | **不成立**。consume 結果為 `denied` 時，tool message 錯誤碼為 `CONFIRMATION_CANCELLED` | `confirmation-graph.ts` | shopping 路徑需要區分（§6.4） |
| 等待審批時可取消 | **不成立**（第 6 版更正，見 S5）。resume schema（harness contract）只接受 `approve`／`deny`；等待審批時沒有 active run，既有 `cancel` 輸入不會轉移審批紀錄，該紀錄會維持 `pending` 直到逾期 | `harness-contracts` resume schema、`platform/interaction-runtime.ts` | 新增 additive 的審批「撤回」轉移，由 graph 處理取消輸入時呼叫（§6.2） |
| 審批逾期可被觀察 | **部分成立**。逾期只在 `consume`（收到 resume）時才判定並轉為 `expired`，沒有背景掃描 | `confirmation.ts` | resume 與撤回時寫入逾期，狀態查詢只計算不寫入；介面不得自行推定狀態（§6.1、§11） |
| 審批紀錄可新增狀態 | **不可**（第 7 版更正，見 S6）。`authorization_confirmations.status` 有 CHECK（`pending`、`approved`、`denied`、`expired`），放寬需要 `DROP CONSTRAINT`，違反 additive migration gate | migration 018；`persistence/migration-additive.ts` | 撤回改以既有 `denied` 加新增 nullable 欄位表達（§6.2、§6.11） |
| resume 的 run 綁定 | `consume` 要求 execution context 的 runId 與審批描述一致；前端從未發出過 tool 審批 resume，經 BFF 的 run 綁定**未被驗證**。第 12 版更正：經 Agent Server 的 resume 一定是新的 run，此綁定必定失敗（見 S9） | `confirmation.ts`、`frontend/src/App.tsx` | 第 12 版改以伺服器端記錄的等待中 run 綁定（§6.14） |
| 審批前有操作識別 | **不成立**。businessEffectId 在審批後 dispatch 時才由 ledger 產生 | `side-effect/business-effect-ledger.ts` | 操作識別改為 tool call 參照 + approvalId（§6.7） |
| 等待 tool 審批時的 `cancel` 分類 | `hasWaitingHitl` 只在天氣澄清 resume 時為 true；但等待審批時沒有 active run，取消在進到分類之前就會因 `NOTHING_TO_CANCEL` 結束（governance 啟用時） | `platform/interaction-runtime.ts`、`runtime/interaction/classify.ts` | 第 6 版改由 shopping 的 opt-in 轉送規則把取消送進 graph（§6.2） |
| 未取得 claim 的執行紀錄 | `prepare` 在效果未提交且 claim 未取得時，以 `status: 'unknown'` 寫入 tool execution；同一 replay key 重播時，`resolveExistingExecution` 對非 committed 紀錄回傳 `SIDE_EFFECT_RECONCILIATION_REQUIRED` | `side-effect/business-effect-ledger.ts`、`side-effect/tool-execution-runner.ts` | 進行中重複不得被當作未知效果（§6.5） |
| 重用結果的內容 | 重用已提交結果時，runner 回傳原執行存下的 payload，內容屬於原操作 | `side-effect/tool-execution-runner.ts` 的 `resolveCommittedResult` | tool 輸出只放效果事實，操作識別由 graph 組成（§5.5） |
| scope 粒度 | BFF 測試中的 active scope 皆為 `scopeType: "tenant"`、`scopeId` 等於 tenant；實際部署值待 T0 確認 | `bff/src/identity.test.ts` 等 | ledger 去重預期涵蓋同一 tenant 的不同 thread（§13 Q2） |
| 去重發生在 tool 執行前 | runner 先做 ledger `prepare`，已提交即重用結果，tool 不會執行；訂單擁有者檢查在 tool 內，因此不會被執行 | `side-effect/tool-execution-runner.ts`、`side-effect/business-effect-ledger.ts` | business effect key 必須含申請者 principal，避免跨使用者去重洩漏（§6.3） |
| BFF 測試入口 | `bff/package.json` 已有 `test`（vitest 加 node test）；根目錄 `AGENTS.md` 所寫「BFF 沒有 test script」已過時 | `bff/package.json` | T9 測試放在 bff 測試目錄，只新增測試檔（§12） |

**apply-change T0 盤點新增結論（2026-10-24，第 5 版依據；完整紀錄見 `.agent-runtime/commerce-assistant-and-approved-side-effects/evidence/t0-inventory.md`）**

| 編號 | 發現 | 證據 | 對設計的影響 |
|---|---|---|---|
| S1 | 審批通過後，pipeline 以 `authorizationAlreadyEvaluated` 呼叫 runner 時，授權結果寫死為 `{ type: "authorized" }` 且**沒有 decisionId**；runner 在 claim 之後發現缺 decisionId，以 `AUTHORIZATION_UNAVAILABLE` 失敗。所有經 confirmation 核准的 side-effect tool 都無法執行 | `tool-dispatch/pipeline.ts` 549–551、702–706；`side-effect/tool-execution-runner.ts` 585–597 | 已消費的審批決策必須傳到 dispatch（§6.10） |
| S2 | runner 在 claim 後遇到未提交即結束的結果（dispatch 前拒絕、授權拒絕、`failed_not_committed`、dispatch 前取消）時只把 tool execution 轉為 failed，business effect 永遠停在 `prepared`；之後同一 key 的提交會被判為未取得 claim | `tool-execution-runner.ts` 712–798；`business_effects.commit_state` CHECK（migration 006） | 未提交即釋放 claim（§6.8） |
| S3 | `executeSideEffect` 在 `prepare` 前不檢查中止訊號；排程器只在排程時檢查 | `tool-execution-runner.ts` 338–370；`tool-dispatch/scheduler.ts` 45–72 | `prepare` 前檢查；claim 後才取消交由 §6.8 釋放 |
| S4 | backend 沒有任何 `card.emit` 的 producer，只有型別與 legacy 映射；前端已有解析 | `platform/agent-runtime-events.ts` 29；`runtime/event-payloads.ts` 34；`frontend/src/lib/agent-runtime-events.ts` 358、489 | X43 必須新增 backend producer（§8.1） |
| S5 | 等待審批時 interrupt 已讓 run 結束（ownership terminal），沒有可取代的 run；取消輸入在 governance 未啟用時成為 graph 新輸入，啟用時為 `NOTHING_TO_CANCEL` no-op；production 未注入 `decideCancellation` | `platform/interaction-runtime.ts` 644–671、880–884、1055–1074；`runtime/interaction/ownership.ts` 220–230；`frontend/src/App.tsx` 535–558 | 取消改在 graph 內處理並撤回（§6.2，第 6 版） |
| S5-a | LangGraph 1.4.14：非 `Command` 的新輸入會丟棄 checkpoint 中等待中的 task；但若輸入沒有任何欄位對應到 state channel，會丟出 `EmptyInputError` | `@langchain/langgraph/dist/pregel/loop.js` 647–722 | shopping graph 宣告 `kind`、`targetRunId` channel（§6.2） |
| S6 | 第 6 版以「在既有欄位加入新狀態值」實作撤回、釋放與未取得 claim 標記：additive migration gate 拒絕 up SQL 的 `DROP CONSTRAINT`，Postgres 的 CHECK 無法不 drop 就放寬；`rolling-deployment-migration` 要求新舊 instance 並存，而 ledger 與取消判定遇未知狀態值即 throw | `persistence/migration-additive.ts`；`openspec/specs/rolling-deployment-migration/spec.md`；`business-effect-ledger.ts` 237–239；`cancel-decision.ts` 85–92 | 一律改為新增 nullable 欄位，既有欄位只寫既有值（§6.11，第 7 版） |
| S7 | pipeline 的 dispatch 一律回傳外層 `succeeded` 包著 `StructuredToolResultEnvelope`；envelope 的 `outcome` 是 `@gun-ai/harness-contracts`（0.1.0-alpha.2）的封閉 strict union，7 個類型都不接受額外欄位，沒有去重類型。第 7 版 §6.5 要求的「governed outcome 保留去重資訊」不改 harness 契約就無法實作 | `tool-dispatch/pipeline.ts` 795、812、829、837；harness `src/tool.ts` 58–92、`src/side-effect.ts` 114–129 | Master 決策：方向 B，harness 契約新增去重結果類型（§6.12，第 8 版） |
| S7-a | backend 沒有任何 `runtimeEvents` producer；前端從每個 update chunk 的頂層與各 node 值讀 `runtimeEvents` 陣列，只有 `showActivityTimeline` 為 true 的 agent 才處理，且丟棄 `context.runId` 不是 active run 的事件 | `frontend/src/lib/legacy-event-adapter.ts` 39–49；`frontend/src/App.tsx` 329–350；`frontend/src/types/agents.ts` | card 發送路徑定為 node 的 state update（§8.1，第 8 版） |
| S8 | BFF 對 `/api/langgraph/*` 為通用 proxy，只以黑名單擋 config 保留欄位、只檢查 `input.kind`；客戶端可經 `POST /threads/{id}/state`、建立 thread 的 `supersteps`、run 的 `command.update`／`command.goto` 與 run input 寫入 graph state。可改寫已核准 tool call 的輸入；可以 `goto` 直達 dispatch，使唯讀 tool 略過授權（既有缺陷，影響所有使用 confirmation 節點的 graph） | `bff/src/server.ts` 69–77、1097–1143；`bff/src/execution-context-boundary.ts`；`@langchain/langgraph-api` 1.4.5 `dist/api/threads.mjs` 11–16、64，`dist/api/runs.mjs`；`frontend/src/App.tsx` 476–560 | Master 決策：納入 X43（§6.13，第 9 版） |
| S9 | T9 發現（2026-10-25）：Agent Server 每建立一個 run（含 `command.resume`）都產生新的 `run_id` 並覆寫 `configurable.run_id`，客戶端無法指定；審批描述記錄的是觸發 interrupt 的原 run，resume 時以新 run 的 context 呼叫 `consume`，而 `consume` 要求兩者相同，因此經 Agent Server 的核准必定 `CONFIRMATION_BINDING_MISMATCH`。`x-active-run-*` header 只用於 governance 的 generation，不影響此綁定。天氣澄清的 resume 以 active run ownership 綁定，不受影響。既有測試讓 interrupt 與 resume 共用同一個 runId，因此未暴露。`mcp_agent` 使用同一組授權節點，同樣受影響（既有缺陷） | `@langchain/langgraph-api` 1.4.5 `dist/api/runs.mjs` 18、`dist/storage/ops.mjs` 993–1001；`runtime/authorization/confirmation-graph.ts` 219、296；`confirmation.ts` 187–200；`platform/interaction-runtime.ts` 346；`runtime/recovery/clarification-resume-authorization.ts` 59；`agents/mcp-agent.ts` 55–60；證據 `evidence/t9-stop-binding.md` | Master 決策：方向 A，`mcp_agent` 一併修正（§6.14，第 12 版） |
| S5-b | interrupt manifest 狀態已有 `superseded`（`waiting`、`resumed`、`expired`、`superseded`、`rejected`）；repository 只有依 interruptId 查詢 | migration 019；`runtime/recovery/interrupt-manifest-repository.ts` | 撤回時 manifest 轉 `superseded`；governance 轉送需要 additive 的「依 thread 查等待中 confirmation manifest」查詢 |
| tool 依 graph 授予 | **不成立**。所有 `LOCAL_PRODUCTION_TOOLS` 會載入到每個 graph | `tools/registry.ts` | 以 X27 agent manifest 限定（§5.4） |
| 前端審批 UI | **不存在**。只有天氣澄清 resume；`card.emit` 以通用時間軸列呈現 | `frontend/src/App.tsx`、`lib/agent-runtime-events.ts` | 新增卡片元件（§11） |
| BFF graph 白名單 | **不存在**，LangGraph 路徑一律透傳 | `bff/src/server.ts` | 預期 BFF 無變更；T0 以測試確認 |

## 3. 責任邊界與資料流

### 3.1 整體資料流

```text
Browser ─ BFF（trusted identity header、既有 proxy、resume 透傳）─ backend shopping_assistant

shopping_assistant（每輪）
  START ─ kind = cancel ─▶ cancel_pending_operation（撤回等待中的審批，§6.2）
        └ 其他 ─▶
  route_intent（結構化輸出 shopping_intent@1，Schema 驗證）
    ├─ product_lookup  → kb_request（只綁 kb_search）→ authorization_gate → physical_dispatch（X14）
    │                  → product_present：驗證 kb_search_result@1 → card.emit(product_result@1) → 簡短回答
    ├─ policy_question → kb_request → authorization_gate → physical_dispatch（X14）
    │                  → policy_answer：evidence_found → 合成 → citation 驗證 → 回答
    │                                   no_source_found → 明確拒答（無 citation）
    │                                   tool error → 明確「目前無法回答」
    ├─ order_operation → order_request（只綁訂單 tool）→ dispatch_readiness（預檢，§6.1）→ authorization_gate
    │                  → authorization_confirmation（interrupt，X20 durable）→ physical_dispatch（X14）
    │                  → order_present：card.emit(order_operation_status@1) → 依狀態回覆
    └─ clarify / unsupported → 誠實說明可協助範圍，不呼叫 tool
```

### 3.2 元件責任

| 元件 | 負責 | 不負責 |
|---|---|---|
| `route_intent` | 產生並驗證意圖；記錄路由結果 | 選擇 tool 參數、回答 |
| `kb_request`／`order_request` | 以限定 tool 集合請模型產生 tool call | 執行 tool |
| 既有 gate／confirmation／dispatch 節點 | X13 授權、durable 審批、X14 dispatch | 業務判斷 |
| `policy_answer` | 合成、citation 驗證、拒答 | 檢索 |
| `product_present`／`order_present` | 驗證 tool output、發出 card、產生回覆 | 修改狀態來源 |
| 訂單 tool | 驗證輸入、呼叫模擬 provider、回報 externalOperationId | 審批、身分判定、去重判定 |
| 模擬訂單 provider | 合成訂單、業務規則、故障注入、狀態查詢 | 真實交易 |
| ledger／runner | 冪等、重用、reconciliation、去重結果 | UI 標籤 |
| reconciliation task store | 為 `outcome_unknown` 建立 durable task | 執行 reconciliation worker（X31） |

## 4. `shopping_assistant` Graph

### 4.1 註冊與身分

- graphId `shopping_assistant`，加入 `langgraph.json`；execution manifest 以自己的 graphId 與節點清單建立，與 `mcp_agent` 不相容時 resume MUST fail-closed（沿用 confirmation 節點的相容性檢查）。
- 以既有 `instrumentGraphWithExecutionContext`、interaction governance 與 Opik instrumentation 包裝；身分與 scope 只來自 BFF trusted header，taskId 由 graph 入口登記產生，resume 時從 checkpoint 的 `executionTaskId` 接回原 task（第 14 版，§6.15）。

### 4.2 State 欄位（依 `backend/AGENTS.md` §3）

| 欄位 | owner node | write timing | readers | default | checkpoint／相容性 |
|---|---|---|---|---|---|
| `messages` | 各節點 append | 每次節點輸出 | 全部 | `[]` | 既有 MessagesAnnotation |
| `toolQueue`、`activeToolCall`、`pendingAuthorization` | 既有 gate／confirmation／dispatch | 同 `mcp_agent` | 同 `mcp_agent` | `[]`／`null` | 沿用既有型別 |
| `kind`、`targetRunId` | 輸入（前端取消輸入 `{ kind, targetRunId }`） | 每次輸入 | START 分流、`cancel_pending_operation` | `null` | 取最後值；只用於分流與比對，不作為授權依據；沒有這兩個 channel 時取消輸入會觸發 `EmptyInputError` |
| `turn` | `route_intent` | 每輪開始 | 全部 | `{ turnId, routedIntent: null, routeStatus: "pending" }` | 可序列化；新欄位，無舊 checkpoint |
| `executionTaskId`（第 14 版，§6.15） | `route_intent` | 每輪開始，寫入入口登記的 taskId | graph 入口（resume 時接回原 task） | `undefined` | 只存 taskId 字串；不在輸入 schema；缺值時 resume fail-closed |
| `turnEvidence` | `product_present`／`policy_answer` | 收到本輪 `kb_search` 結果時 | `policy_answer`、citation 驗證 | `null`，每輪開始重設 | 只存 citations 與 chunkId，不存完整 chunk 以外的 context |
| `runtimeEvents` | 發出 card 的節點（`product_present`、訂單分支節點、`cancel_pending_operation`） | 該節點要發出 card 時 | 前端（經 update chunk，§8.1） | `[]` | 每次 update 取代、不累積；只含 envelope（識別碼與 Enum），不含 note 或自由文字 |
| `runtimeEventCursor` | 同上 | 每次發出 envelope | 發出 card 的節點 | `null` | `{ runId, nextSequence }`；runId 不同時重設為 1（§8.1） |
| `operations` | 訂單分支節點（`order_request` 之後建立項目；審批與 `order_present` 更新） | 每個訂單 tool call 產生時建立；審批結果、tool 結果到達時更新 | `order_present`、狀態 card | `{}`（以 toolCallId 為鍵的 map） | 每項只存 toolCallId、operationId、kind、orderId、state、stateVersion、reason code、去重參照；同一則模型訊息含多個訂單 tool call 時各自獨立。**reducer 規則**：依 toolCallId 合併；同一項只接受 `stateVersion` 大於現值的更新；項目進入 terminal 後忽略任何非 terminal 更新；不同 toolCallId 互不影響 |

- **輸入 schema（第 9 版，§6.13）**：graph 宣告獨立的輸入 schema，只含 `messages`、`kind`、`targetRunId`；上表其他欄位都只能由 graph 節點寫入，run 輸入夾帶時 MUST 不影響 state。
- `turnEvidence` 每輪重設是「無跨輪污染」的結構保證：citation 驗證只接受本輪 `kb_search` 回傳的 citation。
- State 不存 API client、AbortController、credential 或完整 prompt。

### 4.3 意圖路由

- 輸出 Schema `shopping_intent@1`：`{ intent: "product_lookup" | "policy_question" | "order_operation" | "clarify" | "unsupported", rationaleCode: enum }`，strict，拒絕額外欄位。`rationaleCode` 為封閉 Enum（例如 `asks_product_info`、`asks_policy`、`requests_order_change`、`ambiguous`、`out_of_scope`），只供評測與 trace，不作分支條件以外的用途。
- 模型不支援 structured output 時以 capability 設定判定，不以模型名稱分支（`backend/AGENTS.md` §6）。
- Schema 驗證失敗：重試一次（同 prompt 版本）；仍失敗則進入 `clarify`，並記錄 `routeStatus: "schema_invalid"` 與 typed failure。此路徑在評測中計為誤分流，**不得**被當作正確結果吸收。
- 禁止以關鍵字、regex、刪字或固定詞表作為主要路由。
- 一輪只走一個意圖分支。使用者在同一句同時要求兩件事時路由為 `clarify`，請使用者分開（v1 範圍取捨，記於 §13 Q4）。

### 4.4 商品查詢

- `kb_request` 只綁定 `kb_search`，並在 tool 描述中說明此分支只查商品來源；`sourceTypes` 由模型依 tool schema 填入，dispatch 仍做二次驗證。
- `product_present` 以 `kb_search_result@1` Schema 驗證 tool output，**每個 sourceId 一張** `product_result@1` card（§8.2）：同一商品有多個 evidence chunk 時，只取排序最前的 chunk 與其 citation。卡片欄位只來自 citation 與 chunk 的結構化欄位（sourceId、title、片段、citationId），**不從自然語言回答解析**。
- `no_source_found` → 不發卡片，回答聲明知識庫沒有符合的商品。

### 4.5 政策問答

- `policy_answer` 在 `evidence_found` 時以 prompt `shopping-policy-answer-v1` 合成，要求以 citationId 標記；完成後呼叫 X42 的 deterministic citation 驗證。
- 驗證失敗：不呈現未驗證陳述，改回「目前無法提供經驗證的答案」，發出 X42 已定義的驗證失敗事件，評測計為引用錯誤。不重新生成（避免無證據微調迴圈）。
- `no_source_found` → 明確拒答且不含 citation。
- `kb_search` typed failure（逾時、取消、provider error、授權拒絕）→ 明確「目前無法回答」並附可重試提示，**不得**以參數知識斷言政策。
- prompt 變更依 `backend/AGENTS.md` §5：先建立 golden case（含 X42 manual inspection 列出的 4 題 judge 不一致題作為參考）。

### 4.6 訂單操作

- `order_request` 只綁定三個訂單 tool。模型可請求退款或取消，但 tool input 不含任何審批、身分、tenant 欄位。
- 同一則模型訊息含多個訂單 tool call 時，每個 tool call 是獨立操作：各自在 `operations` 中有一項、各自的審批（沿用既有 gate 依序處理 toolQueue）、各自的狀態 card。不依模型的平行 tool call 能力改變行為。
- 狀態回覆以 tool output 與審批結果為準，**不得**從助理先前文字推斷操作狀態。

## 5. Tool 契約

### 5.1 `order_refund_request`

| 欄位 | 值 |
|---|---|
| `toolId`／`toolVersion` | `order_refund_request`／`1.0.0` |
| `inputSchema` | `{ orderId: string(識別碼格式), lineItems?: { lineItemId: string, quantity: int ≥1 }[] (1..50), reasonCode: enum, note?: string(0..500) }`，strict；省略 `lineItems` 表示整筆訂單 |
| `outputSchema` | `order_effect_result@1`（§5.5） |
| `sideEffectClass` | `external_mutation`（模擬；依 v7 Execution mode 表） |
| `requiredCapabilities` | 明示的訂單退款 authorization action（命名於 T0 對齊既有 action 慣例） |
| `executionProfile` | `trusted_in_process`；egress destinations 為空 |
| `idempotency` | `business_effect_key`，descriptorRef 指向本 tool 的 SideEffectToolDescriptor（§6.3） |
| `approvalPolicyKey` | 訂單變更需要人工審批的 policy key（命名於 T0 對齊）；對應 risk policy `requireConfirmation: true` 與版本化審批逾時 |
| `timeoutRetryClass` | mutation 類；審批後 dispatch `maxAttempts = 1`（既有行為） |
| `compensation` | `reconcile_only`：可查詢結果，不提供補償 |
| `dataClassification` | `commerce:internal-synthetic`（暫定，T0 對齊既有分級 key 慣例） |

### 5.2 `order_cancel`

與 §5.1 相同，差異：input 為 `{ orderId, reasonCode, note? }`；business effect key 不含明細。

### 5.3 `order_operation_status`（唯讀）

- input：`{ operationId?: string, orderId?: string }`，至少一個；strict。
- 只讀取操作摘要（§6.7）、ledger、審批決策與 reconciliation task，回傳目前狀態（不是歷史）。`read-only`、`idempotency: read_only`、`approvalPolicyKey` 為 none、`compensation: none`。
- 只回傳屬於目前 tenant、scope 與 principal 的操作；其他一律 `ORDER_OPERATION_NOT_FOUND`。
- 第 11 版（Master 2026-10-25 決策 A1）：`order_operation_status@1` 的 `orderRef`、`kind` 與 `operationRef.toolCallId` 是必填，但審批紀錄只有 tool 名稱，不含 tool input。因此在建立審批時另存操作摘要（§6.7），查詢從摘要取得這些欄位；契約不放寬。
- 以 `operationId` 查詢時以摘要的 approvalId 比對；以 `orderId` 查詢時回傳該訂單最近建立的一筆操作；兩者都給時須同時相符。只有摘要沒有對應審批紀錄（審批未建立成功）時視為不存在。
- 狀態對照（讀取時計算，不寫入）：
  - 審批 `pending` 且未過期 → `awaiting_approval`（帶 `approvalExpiresAt`）；`pending` 但 `expires_at` 已過、或 `expired` → `approval_expired`；`denied` 且 `withdrawn_at` 有值 → `cancelled_before_effect`；其餘 `denied` → `approval_denied`。
  - 審批 `approved` 但沒有以其 decisionId 連結的 tool execution → `approved`（尚未 dispatch，或 dispatch 前被拒而未 claim；後者 ledger 沒有紀錄可區分）。
  - 執行是去重（`termination_cause = 'deduplicated'`）→ `deduplicated`：執行為 `committed` 時 reason 是 `committed_result_reused`；否則依原效果目前狀態，`unknown` 為 `original_outcome_unknown`、其餘為 `in_flight_duplicate`（ledger 不保存當時的 reason）。`dedup.of` 是原效果最近一筆非去重執行的審批（§6.5）。
  - 持有 claim 的執行：效果 `committed` → `confirmed`（帶 businessEffectId、externalOperationId）；有 reconciliation task、效果或執行為 `unknown` → `outcome_unknown`（帶 `reconciliationTaskId`）；效果已釋放且 `termination_cause = 'cancelled_before_dispatch'` → `cancelled_before_effect`；其他已釋放 → `failed`（ledger 不保存 provider 失敗碼，不帶 `reasonCode`）；仍持有 claim → `executing`。
  - 以上皆不符的組合 → `outcome_unknown`，`reasonCode = ORDER_OPERATION_STATE_INDETERMINATE`，不推測為成功或失敗。
- 查詢結果的 `stateVersion` 是生命週期序位（`awaiting_approval` 2、`approved` 3、`executing` 4、`outcome_unknown` 5、terminal 6）。查詢結果是獨立的 tool 結果，不併入對話中以 toolCallId 為鍵的 card reducer。
- **Master 決策（2026-10-25，階段性 review M1、M2、M4、m1）**：
  - M1：ledger 已 `committed` 時回報 `confirmed`，即使持久化不確定時開的 reconciliation task 仍 open。理由：查詢以權威 ledger 為準；對話中的 card 是當下 runner 無法確認時的結果，查詢不改寫它。spec「查詢自己的操作」的未知結果情境指 ledger 本身為未知。
  - M2：去重 reason 依原效果目前狀態推得，不另行保存；原效果之後狀態改變時，查詢的 reason 可能與當時 card 不同。
  - M4：核准後、claim 前被拒（例如 decision 驗證失敗）不在 ledger 留紀錄，查詢停在 `approved`。只在異常情況發生，列為後續評估。
  - m1：查詢不呈現 note、reasonCode、數量或金額，操作摘要刻意只存識別碼（資料最小化）；呈現操作細節不在本 change。

### 5.4 註冊、授予與 dispatch 強制

- 三個 tool 都經 X27 SDK manifest 註冊（比照 `kb_search` adapter 的「host contract 驗證後才 registerTool」模式），manifest 缺欄位 fail-closed。
- 新增 `shopping_assistant` 的 X27 agent manifest（`kind: "agent"`），tools 列出 `kb_search` 與三個訂單 tool。tool runtime 依 agent manifest 篩選；**其他 graph 不得取得訂單 tool**（以測試驗證 `mcp_agent` 的 tool 清單不含訂單 tool）。
- `shopping_assistant` 的 tool runtime MUST 建立 X14 dispatch pipeline，不受來源 feature flag 影響；pipeline、side-effect ledger 或 confirmation store 不可用時，訂單 tool MUST typed deny（`SIDE_EFFECT_LEDGER_UNAVAILABLE` 等既有碼），不得以預設 executor 執行。

### 5.5 Tool output 與操作狀態的分工

tool 只知道「這次對模擬訂單系統做了什麼」，不知道 approvalId、toolCallId 或是否被去重；而重用已提交結果時，runner 回傳的是原執行存下的 payload。因此 tool output 只放**效果事實**，操作識別與狀態由 graph 組成。

**Tool output：`order_effect_result@1`**（被 ledger 保存、可被重用）

```text
{ schemaVersion: "order_effect_result@1",
  kind: "refund_request" | "cancel",
  orderId,
  effect: "committed",           // 只有成功提交才有 output；失敗走 typed failure
  externalOperationId,           // 模擬 provider 的操作識別
  providerRecordedAt }
```

**操作狀態：`order_operation_status@1`**（由 `order_present` 依 graph state、審批結果與 governed outcome 組成，每次提交各自一份）

```text
{ schemaVersion: "order_operation_status@1",
  operationRef: { toolCallId, operationId? },  // 本次提交；operationId = approvalId（§6.7）
  kind, orderRef: { orderId },
  state: OrderOperationState,                  // §7
  stateVersion,
  businessEffectId?,                           // dispatch 後
  externalOperationId?,                        // 來自 effect result（含重用）
  dedup?: { of: operationId, reason: "committed_result_reused" | "in_flight_duplicate" | "original_outcome_unknown" },  // of = 原操作的 approvalId
  approvalExpiresAt?, reasonCode?, reconciliationTaskId? }
```

- 去重時，`operationRef` 一律是**本次提交**的；原操作只出現在 `dedup.of`。重用的 effect result 只提供 `externalOperationId` 等事實。

## 6. 審批、冪等與未知結果

### 6.1 審批流程

1. 模型產生訂單 tool call → 狀態 `requested`（以 toolCallId 參照，§6.7）。
2. **dispatch 就緒預檢**：在建立審批前，`order_request` 之後的節點確認 dispatch pipeline、side-effect ledger 與 confirmation store 可用；不可用 → `failed`（`ORDER_DISPATCH_NOT_READY`），**不建立審批**，避免使用者核准後才失敗。dispatch 時仍由 ledger fail-closed 再檢查一次（預檢不取代 dispatch 的檢查）。
3. `authorization_gate` 呼叫 `authorizeTyped` → risk policy 要求確認 → 持久化審批描述與 interrupt manifest → 狀態 `awaiting_approval`，`operationId = approvalId`。
4. `authorization_confirmation` 以 LangGraph interrupt 等待；前端審批卡片以既有 resume schema（`tool_authorization_confirmation@1.0`，決定只有 `approve`／`deny`）透過 BFF resume。resume 由 Agent Server 產生的新 run 承載，審批以伺服器端記錄的等待中 run 與同一 thread 綁定，不比對承載 resume 的 run，也不使用客戶端的 active run 識別（§6.14，第 12 版）。
5. `consume` 一次性消費：`approved` → `approved` → `physical_dispatch`（帶著已消費的 decisionId，§6.10）；`denied` → `approval_denied`；逾時 → `approval_expired`；已撤回 → `cancelled_before_effect`；binding mismatch／replay → typed failure，不得執行。
6. **逾期由 server 判定**：
   - 寫入路徑：既有 `consume`（resume）與新的撤回轉移，遇到已超過 `expiresAt` 的 `pending` 審批時轉為 `expired`（撤回本來就是寫入動作）。
   - 讀取路徑：`order_operation_status` 是唯讀 tool，**不寫入**；讀到 `pending` 且已超過 `expiresAt` 時，計算並回報為 `approval_expired`。之後任何 resume 仍會由 `consume` 判定為逾期，兩者結果一致。
   - 沒有背景掃描（記入 Retrofit Debt）；資料庫中的狀態可能暫時仍為 `pending`，介面依 §11 呈現期限而不自行推定狀態。
7. 審批只能由 resume 記錄；Agent 不得自我批准（既有 `trusted-tool-authorization`）；模型輸出或檢索內容中的「已核准」文字無效。

### 6.2 取消語意

- **前提（T1 開工核對，S5）**：interrupt 發生時 graph 串流正常結束，interaction runtime 隨即把 ownership 標為 terminal，**等待審批期間沒有任何 run 在執行**，也就沒有 run 可以取代。前端的取消是 `thread.stop()` 加上送出 `{ kind: "cancel", targetRunId }` 輸入。第 5 版「先撤回、再取代 run」的前提不成立，第 6 版改為**在 graph 內處理取消輸入並撤回**（Master 決策：方向 1）。
- **`awaiting_approval` 時取消（撤回）**的流程：
  1. **取消輸入送達 shopping graph**：
     - interaction governance 未啟用（`INTERACTION_POLICY` 未設定，目前預設）：取消輸入直接成為該 thread 的一次新輸入。
     - governance 已啟用：既有行為會因「沒有 active run」回傳 `NOTHING_TO_CANCEL` 且不執行 graph。`shopping_assistant` 使用自己的 orchestrator 設定，開啟 opt-in 規則：取消輸入的 thread 若有 `kind = confirmation`、`status = waiting` 的 interrupt manifest，改為以新 run 送進 graph。其他 graph 不開啟，行為不變。
  2. **graph 接得到取消輸入**：shopping graph 的 state MUST 宣告承接取消輸入的 channel（`kind`、`targetRunId`），否則 LangGraph 會因沒有任何輸入對應到 channel 而丟出 `EmptyInputError`。START 之後依 `kind` 分流：`cancel` → `cancel_pending_operation`；其他 → `route_intent`。
  3. **LangGraph 丟棄舊的等待中 task**：非 `Command` 的新輸入套用時，checkpoint 中等待中的 task 會被丟棄（LangGraph 1.4.14 `pregel/loop.js` `_first`），舊的 interrupt 不會再被 resume。
  4. **`cancel_pending_operation` 撤回**：只依 checkpoint 中伺服器端保存的 `pendingAuthorization` 審批描述與 `activeToolCall` 決定撤回對象；客戶端的 `targetRunId` 只用來比對，**不作為授權依據**。
     - 沒有等待中的審批 → 回覆「目前沒有可取消的申請」，不寫任何狀態。
     - `targetRunId` 存在且不等於審批描述的 runId → 視為過期的取消，不撤回，回覆同上。
     - 否則呼叫審批儲存的撤回轉移：以單列 CAS 把 `pending` 轉為既有的 `denied`，並同時寫入新增欄位 `withdrawn_at` 與 `withdrawn_by_principal_id`（§6.11）。綁定條件為 approvalId、decisionId、tenant、scope，以及目前 principal 必須在 `allowedApproverPrincipalIds` 內；**不要求 runId 相同**，因為取消輸入一定是新的 run。
       - 成功 → interrupt manifest 由 `waiting` 轉為 `superseded`；task 與 step 的狀態轉移與既有 deny 相同（既有缺陷見 §19 SI-3）；`permission_decisions` 以 `deny`、`CONFIRMATION_CANCELLED` 記錄（沿用 harness 契約既有 reason code）；「撤回」與「拒絕」以 `withdrawn_at` 是否有值區分；操作為 `cancelled_before_effect`，發出狀態 card，清除 `pendingAuthorization`／`activeToolCall`。
       - 已逾期 → 轉為 `expired`，操作為 `approval_expired`。
       - 已被核准或拒絕 → 回傳 typed `CONFIRMATION_ALREADY_DECIDED`，不改狀態。
     - 同一則訊息裡尚在 `toolQueue`、還沒建立審批的其他訂單 tool call，一併結束為 `cancelled_before_effect`（從未建立審批，也從未 claim）。
  5. **撤回失敗**（審批儲存不可用等）：回覆 typed `CONFIRMATION_WITHDRAW_FAILED`，**保留** `pendingAuthorization` 讓使用者可重試取消；狀態維持 `awaiting_approval`。因為步驟 3 已丟棄舊 interrupt，該審批之後即使在資料庫被核准，也沒有 graph 路徑能執行它，效果不會發生（fail-closed）。已知限制：撤回失敗後只支援重試取消，核准路徑不再可用；記入 Retrofit Debt。
- 撤回只發生在 `shopping_assistant` 的取消路徑；其他 graph 的取消行為與 tool message 不變。
- 不修改 harness 的 resume schema（不加 `cancel` 決定）：撤回與審批是不同行為者的不同動作，混入審批決定會讓「拒絕」與「撤回」在契約上難以區分，且需要 harness 契約的 major 變更。
- 撤回不新增狀態值：`status` 寫既有的 `denied`，以新增的 nullable 欄位 `withdrawn_at`、`withdrawn_by_principal_id` 區分（additive runtime migration，§6.11）。舊版 instance 看到的是已拒絕，同樣不可再消費。
- **`approved` 但尚未 ledger claim 時取消**：既有 run cancellation 經 step lock lease 傳到 runner；runner MUST 在 `prepare` **之前**再檢查一次中止訊號（S3），已中止則回傳 `cancelled`（dispatch 前）→ `cancelled_before_effect`，ledger 沒有 claim。
- **已 claim 但尚未 dispatch 時取消**：runner 回傳 `cancelled`（dispatch 前），並依 §6.8 釋放 claim → `cancelled_before_effect`。之後同一使用者可以重新申請（需重新審批）。
- **`executing`（已 dispatch）時取消** → 無法中止效果；狀態維持 `executing`，最終為 `confirmed` 或 `outcome_unknown`。介面顯示「已收到取消要求，但操作已在執行，無法中止」，**永遠不顯示為已取消**。
- 不新增第二套取消管道：撤回由既有 `cancel` 輸入觸發，在 shopping graph 內完成。

### 6.3 Idempotency 聲明

| tool | 邏輯操作識別（business effect key 原料） | 不納入 | 未知結果處理 |
|---|---|---|---|
| `order_refund_request` | `order_refund_request@1`、申請者 principalId（server 端 execution context）、orderId、正規化明細（依 lineItemId 排序；整筆為 `all`） | attempt、toolCallId、runId、threadId、reasonCode、note | reconciler 查詢 provider；仍無法判定 → `outcome_unknown` + reconciliation task |
| `order_cancel` | `order_cancel@1`、申請者 principalId、orderId | 同上 | 同上 |
| `order_operation_status` | 唯讀 | — | — |

- key 經既有 `hashBusinessEffectKey` 雜湊；ledger 以 `(tenant, scope, key)` 保證唯一。tenant、scope 與 principal 只來自 server 端 execution context。
- **為什麼 key 含申請者 principal**：去重發生在 tool 執行之前（runner 先 `prepare`，已提交即重用結果），訂單擁有者檢查在 tool 內，重用時不會執行。若 key 不含申請者，同 tenant 的使用者 B 對使用者 A 的訂單申請相同退款時，會直接拿到 A 的去重結果（含 A 的 externalOperationId 與 approvalId），洩漏 A 的訂單存在且已退款。key 含申請者後：
  - 同一使用者在不同 thread 的重複申請仍會去重；
  - 不同使用者永遠不共用 business effect，B 的申請會 claim 新效果、執行 tool，由擁有者檢查回傳 `ORDER_NOT_FOUND`（未提交），與真正查無訂單無法區分。
- 已知 UX 代價：非擁有者要先經過審批才會得到 `ORDER_NOT_FOUND`。審批卡片只顯示申請者自己輸入的內容，不洩漏訂單資訊；記入 Retrofit Debt。
- replay key 沿用既有規則（同一 logical tool call 的 resume／replay 不重複執行）。
- 同一 replay key 但 request hash 不同 → 既有 `SIDE_EFFECT_REPLAY_CONFLICT`，不重用舊結果。

### 6.4 拒絕／逾期／取消的區分

- 既有 `mcp_agent` 的錯誤碼（`CONFIRMATION_CANCELLED`、`CONFIRMATION_TIMEOUT`）與送給模型的 tool message 內容**逐位元組不變**。
- 共用的 confirmation 節點 factory 新增 opt-in 選項（預設關閉）；只有 `shopping_assistant` 開啟，開啟時在 tool message 與 graph state 中加入機器可讀的 `confirmationOutcome`（`denied` | `expired` | `withdrawn`），映射至 `approval_denied`、`approval_expired`、`cancelled_before_effect`。最終欄位名於 T1 對齊；不得依錯誤字串反推狀態。
- 來源：`denied`、`expired` 由 confirmation 節點的 `consume` 結果產生；`withdrawn` 由 §6.2 的 `cancel_pending_operation` 產生。撤回後若仍有人送出 resume，`consume` 回傳 `CONFIRMATION_REPLAYED_OR_EXPIRED`，opt-in 節點再查審批紀錄的目前狀態：`status = denied` 且 `withdrawn_at` 有值時映射為 `withdrawn`，不依錯誤字串推斷。`consume` 在一般拒絕時回傳的 `denied` 不會帶 `withdrawn_at`，兩者不會混淆。
- `mcp_agent` 不開啟此選項，因此本 Change 不改變其模型 context（以既有 confirmation 測試與 tool message snapshot 驗證）。

### 6.5 去重可觀察性

- **表達方式（第 8 版，S7）**：去重以 harness 契約新增的 `deduplicated` 結果類型表達（§6.12），放在 envelope 的 `outcome`。只有選擇接收的 dispatch 來源（`shopping_assistant`）會得到這個類型；其他來源維持第 7 版以前的值（重用 → `succeeded` 帶原結果；進行中重複 → `rejected_before_dispatch`／`SIDE_EFFECT_CLAIM_NOT_ACQUIRED`），行為與錯誤碼不變。
- runner 重用已提交結果（`existing_committed`）→ `deduplicated`、`reason: committed_result_reused`，帶原 business effect 參照與原結果 → `order_present` 組成 `state: deduplicated`、`dedup.of` 指向原操作，並帶回原操作結果（`confirmed`）。
- 並行重複且原操作仍在進行（原 business effect 為 `prepared` 且 `released_at` 為 null，即有一個執行正持有 claim）→ `deduplicated`、`reason: in_flight_duplicate`，不是 `rejected_before_dispatch` 也不是 failure；第二次提交不執行 provider 呼叫。原效果已釋放（`commit_state = prepared` 且 `released_at` 有值，§6.8）時**不是**重複，而是可重新占用。
- 原效果的結果未知（`commit_state = unknown`）→ `deduplicated`、`reason: original_outcome_unknown`；本次提交不 dispatch、不建立 reconciliation task，原操作自己維持 `outcome_unknown`。
- **原操作識別的解析**：`deduplicated` 只帶 `original.businessEffectId`（與可得時的 `original.toolExecutionId`），不帶 approvalId（harness 不認識業務操作識別）。`order_present` 以唯讀查詢依 business effect 找出持有或完成該效果的執行，經既有 decisionId 連結找到原審批的 approvalId，作為 `dedup.of`。第 11 版（Master 決策，階段性 review M3）：取**最近一筆非去重**的執行，也就是目前持有 claim 或完成提交的那一次；效果被釋放後重新占用時，較早已釋放的嘗試不是原操作。查詢只限目前 tenant 與 principal；查不到時仍為 `deduplicated`，`dedup.of` 省略，並記錄 typed observation（不得改判為失敗）。
- circuit breaker：`deduplicated` 不計為失敗（既有 `toCircuitRecordOutcome` 只計 `failed_not_committed`，新增類型 MUST 明確列為非失敗）。
- **進行中重複的執行紀錄不是未知效果**：目前 `prepare` 會為未取得 claim 的提交寫入 `status: 'unknown'`，重播時被判為需要 reconciliation。修正後：
  - 該執行紀錄 MUST 可與「已 dispatch 但結果未知」區分：`tool_executions` 新增 nullable 欄位 `claim_disposition`（新欄位自帶 CHECK，值只有 `not_claimed`），未取得 claim 時寫入 `status = 'failed'`（既有值）與 `claim_disposition = 'not_claimed'`，不再寫 `unknown`（§6.11）。如此取消判定（`deriveCancellationPhase`）也不會再把重複提交誤判為結果未知。
  - 同一 replay key 重播時，依**原 business effect** 的目前狀態決定：已提交 → `committed_result_reused`；仍在進行 → `in_flight_duplicate`；原效果為未知 → `original_outcome_unknown`（原操作自己是 `outcome_unknown`）。
  - 只有實際 dispatch 過的執行可以觸發 reconciliation 或建立 reconciliation task；重複提交永遠不會。
- 去重結果的組成依 §5.5：`operationRef` 是本次提交，原操作只在 `dedup.of`。
- 既有消費者：未選擇接收的來源得到的值不變；對 outcome 做窮舉處理的 backend 消費者（pipeline 的 circuit 與 audit 映射、`tool-governance.ts` 的 legacy 錯誤映射、`governed-outcome.ts`）MUST 明確處理 `deduplicated`，未處理時 fail-closed，不得落入成功或靜默忽略。精確型別依 §6.12，行為以 `side-effect-tool-execution-runtime` delta 為準。

### 6.12 harness 契約新增去重結果類型（S7，第 8 版，Master 決策：方向 B）

**前提**：`@gun-ai/harness-contracts` 是 Master 自有套件，Master 授權直接修改，不另開 change。harness repo 不在本 repo 內；本 repo 的 CCR 寫入檢查不允許寫入 workspace 以外的路徑，因此 harness 修改 MUST 在以 harness repo 為工作目錄的 session 中完成，依該 repo 的規則與 Master 在該處的授權（task TH）。

**新增類型**（三處定義同步：`tool.ts` 的 `governedToolOutcomeSchema` 與 `GovernedOutcome`、`side-effect.ts` 的 `GovernedToolOutcome`）：

```text
{ type: "deduplicated",
  reason: "committed_result_reused" | "in_flight_duplicate" | "original_outcome_unknown",
  original: { businessEffectId: string, toolExecutionId?: string },   // strict
  result?: unknown }                                                  // 只有 committed_result_reused 必填
```

- zod schema 為 strict；`reason = committed_result_reused` 時 `result` 必填，其他 reason 時 `result` MUST 不存在（以 refinement 或拆成兩個 strict 物件表達，由 harness 實作決定，但驗證行為必須如此）。
- `ToolExecutionTerminationCause` 新增 `deduplicated`，供未取得 claim 的執行紀錄與 envelope 的 `terminationCause` 使用。
- 不加入任何業務語意（訂單、退款、approvalId）；harness 只表達 dispatch 層事實。業務操作識別由 graph 解析（§6.5）。
- 版本：harness 發 `0.1.0-alpha.3`；同 repo 其他 `@gun-ai/*` 套件是否同步發版由 TH 依 harness repo 的版本規則決定。發版到 registry 是對外動作，由 Master 執行或明確授權。
- `api-surface.json`、CHANGELOG 與 harness 自身測試在 TH 一併更新。

**本 repo 的配合（T2b）**：

- `backend/package.json` 與 lockfile 把 `@gun-ai/*` 升到 TH 發布的版本（只升版本，不改其他依賴）。
- pipeline 的 runner 結果映射：選擇接收的來源（dispatch 設定中的 opt-in，預設關閉；`shopping_assistant` 開啟）把 `source: "cache"` 映射為 `committed_result_reused`、未取得 claim 依原效果狀態映射為 `in_flight_duplicate` 或 `original_outcome_unknown`；未選擇接收的來源維持既有映射。
- 窮舉消費者明確處理 `deduplicated`（§6.5）。`tool-governance.ts` 的 legacy 映射：帶 `result` 時回傳原結果，否則回傳與既有 `SIDE_EFFECT_CLAIM_NOT_ACQUIRED` 相同的錯誤字串，使既有 graph 即使收到也行為不變。

**部署相容（Master 決策，§6.12）**：目前沒有對外服務、沒有其他採用者，只有本機 Postgres，因此**不要求**舊版 runtime 能解析 `deduplicated`，也不另加「全部 instance 升級後才發出」的 flag。資料庫層的 additive 規則（§6.11）不受此決策影響，仍須遵守。

### 6.6 未知結果與 reconciliation task

- 觸發：dispatch 後逾時、回應遺失、輸出驗證失敗於提交後、ledger 持久化不確定。
- 先由 runner 呼叫 tool 宣告的 reconciler（向模擬 provider 依 business effect key 或 externalOperationId 查詢）：
  - `committed` → `confirmed`（來源標記為 reconciled）。
  - `not_committed` → 不自動重試（審批後 `maxAttempts = 1`）→ `failed`，原因 `effect_not_committed`，並依 §6.8 釋放 claim。
  - `unknown` → `outcome_unknown`。
- `outcome_unknown` MUST 建立 durable reconciliation task：`{ reconciliationTaskId, tenantId, scopeId, businessEffectId, toolExecutionId, externalOperationId?, reasonCode, status: "open", createdAt }`，以 `businessEffectId` 唯一（重複建立為 no-op）。
- task 建立失敗 → 仍回報 `outcome_unknown`，同時發出 audit 與 typed `RECONCILIATION_TASK_PERSISTENCE_FAILED`，**不得**回報成功或失敗。
- **提交後持久化不確定（第 10 版，Master 2026-10-25 決策）**：dispatch 之後第一次寫入 ledger 失敗（attempt 結束紀錄、標記未知、提交結果三者任一）時，runner MUST 先以 tool 宣告的 reconciler 查詢，不得直接回報未知：
  - `committed`（且帶回結果）→ 以 reconciled 來源再寫入提交結果**一次**：成功 → `confirmed`；仍失敗 → `outcome_unknown`（`SIDE_EFFECT_PERSISTENCE_UNCERTAIN`）並建立 task。
  - `not_committed` → 依 §6.8 釋放 claim → `failed`（`SIDE_EFFECT_NOT_COMMITTED`），不自動重試；釋放寫入失敗 → `outcome_unknown` 並建立 task。
  - `unknown`、`committed` 但沒有結果、reconciler 拋錯，或 tool 未宣告 reconciler → `outcome_unknown` 並建立 task。
  - 已在 reconciliation 之後才發生的寫入失敗（reconciled 結果寫入失敗、`not_committed` 的釋放失敗、重試前的狀態轉移失敗）不再 reconcile 第二次，直接建立 task。
  - 再寫入時，同一個 tool execution 已存在的 result reference 若 result hash、tenant、scope、principal 與 tool version 都相同即沿用（result reference 本以 `tool_execution_id` 唯一）；任一不同仍為衝突，不覆蓋。
  - 不迴圈、不重新 dispatch。先前失敗的寫入可能其實已生效（例如交易已提交但回應遺失），此時再寫入會因 CAS 不符而失敗並落入 task，由 X31 依 ledger 目前狀態結案。
  - task 的 `reasonCode`：reconciler 回報 `unknown` 時用其 reason，其餘為 `SIDE_EFFECT_PERSISTENCE_UNCERTAIN`。
  - 範圍：與建立 task 同為 runner 的 opt-in，只有 `shopping_assistant` 的 dispatch 來源開啟；未開啟的來源（`mcp_agent` 等）維持原行為與錯誤碼，`tool-scheduling-resilience` fixture 的 `persistenceUncertain`（首次 `SIDE_EFFECT_PERSISTENCE_UNCERTAIN`、resume `SIDE_EFFECT_RECONCILIATION_REQUIRED`）不變。
- 存放於 runtime Postgres 新 migration（只建立新表，沿用 runtime migration runner，遵守既有 `rolling-deployment-migration` 規則，§6.11）。reconciliation worker 屬 X31。

### 6.7 操作識別

- businessEffectId 要到審批後 dispatch 才由 ledger 產生，不能作為整個生命週期的識別。
- **`operationRef.toolCallId`**：模型產生訂單 tool call 時即存在，replay 與 resume 時不變，是 card 與前端 reducer 的鍵，涵蓋 `requested` 起的所有狀態。
- **`operationId = approvalId`**：審批描述建立後存在、durable，供 `order_operation_status` 查詢與 `dedup.of` 參照。
- 連結沿用既有欄位，不新增對照表：approvalId ↔ decisionId（審批紀錄）↔ tool execution 的 decisionId（ledger 既有 `linkAuthorizationDecision`）↔ businessEffectId。T0 確認 pipeline 確實寫入 decisionId；若未寫入，以 T2 的 additive 修改補上。
- `order_operation_status` 對審批前與審批中的狀態讀取審批紀錄；dispatch 後讀取 ledger 與 reconciliation task。
- **操作摘要（第 11 版，Master 決策 A1）**：審批紀錄不含 tool input，查不到 orderId。因此 `shopping_assistant` 在建立審批時，先把操作摘要寫入新表 `order_operation_requests`（approvalId、tenant、scope、申請者 principal、toolCallId、kind、orderId、正規化的明細識別；不存 note、reasonCode 或數量），再寫審批紀錄與 interrupt manifest。
  - 寫入點：授權 gate 新增 opt-in 的「建立審批前記錄」掛點，只有 `shopping_assistant` 開啟且只記錄訂單變更 tool；其他 graph 不受影響。
  - **fail-closed**：摘要寫入失敗時不建立審批與 interrupt，該 tool call 以 `ORDER_DISPATCH_NOT_READY` 結束（同就緒預檢失敗），audit `shopping.order.request_not_recorded`。
  - 摘要先寫、審批後寫：審批寫入失敗時只留下沒有審批紀錄的摘要，查詢一律視為不存在，不影響任何狀態。
  - 摘要只新增、不更新；狀態永遠由審批紀錄與 ledger 決定，摘要只提供識別。
- `requested` 在 dispatch 就緒預檢失敗或授權拒絕時是唯一出現過的狀態，此時沒有 operationId，只能以 toolCallId 參照，`order_operation_status` 查不到（只存在於該輪對話）。

### 6.8 未提交即釋放 claim（S2，Master 決策：做法 A）

**問題**：claim（business effect 為 `prepared`）只在「提交」或「未知」時有後續狀態；未提交即結束時，claim 會永遠留著，之後同一使用者的同一邏輯操作永遠無法執行。性質是「孤兒鎖」：持有者已結束，鎖卻沒釋放。

**決策**：在「**確定未提交**」的出口集中釋放 claim。第 7 版起「已釋放」不再是新的狀態值，而是 `commit_state = 'prepared'` 加上新增 nullable 欄位 `released_at` 有值（§6.11）。

- **何時釋放**（皆為確定未提交）：
  - dispatch 前就結束：授權拒絕、dispatch 前拒絕、dispatch 前取消（含 §6.2 已 claim 未 dispatch 的取消）；
  - tool 回報 `failed_not_committed`（例如 `ORDER_NOT_FOUND`、`ORDER_NOT_ELIGIBLE`、`ORDER_PROVIDER_UNAVAILABLE`）；
  - reconciliation 確認 `not_committed`。
- **絕不釋放**：結果未知（`unknown`）、已提交（`committed`）、持久化不確定本身。持久化不確定時，只有 §6.6 的 reconciler 確認 `not_committed` 後才釋放（第 10 版）；其餘未知一律走 `outcome_unknown` 與 reconciliation task。
- **集中處理**：釋放放在 runner 的結束出口一次處理，不在各錯誤分支分別處理，避免遺漏任何一條路徑。
- **釋放寫入失敗（第 16 版，F3；Master 2026-10-27 確認）**：
  - **問題**：集中出口的釋放寫入失敗時，claim 仍然留著，runner 卻照樣回報原本的 failed／cancelled。之後同一 key 的申請都會被判為進行中重複，也沒有 task 接手（Codex S1～S8 核對 F3）。
  - **規則**：與 §6.6 中 reconciled 路徑的釋放失敗做法相同：MUST NOT 回報一般的 failed／cancelled，改回 `deferred`／`SIDE_EFFECT_PERSISTENCE_UNCERTAIN`，並建立 reconciliation task（reasonCode `SIDE_EFFECT_PERSISTENCE_UNCERTAIN`）。task 建立與 audit 依 §6.6；建立 task 屬 runner 的 opt-in，未開啟的來源不建立 task，但回傳值同樣改為 `deferred`。
  - **語意**：效果其實沒有提交，未確定的只有 claim 的釋放。因此由 X31 依 ledger 目前狀態結案（reconciler 確認 `not_committed` 後再釋放）。不重新 dispatch，也不自動重試。對使用者呈現為 `outcome_unknown`，直到 task 結案。
  - **替代方案**：維持原本的 failed，另外加 typed audit 並為殘留的 claim 建立清理 task。不採用，理由是要新增 task 種類與 reasonCode，而且回報「已結束」時 claim 實際上還在，等於掩蓋了持久化不確定。
- **釋放的寫入**：以 CAS 在 `commit_state = 'prepared' AND released_at IS NULL` 的 business effect 上寫入 `released_at`，同時把持有 claim 的 tool execution 轉為 failed；兩者依 §6.9 的順序在同一交易內完成。
- **重新占用**：新的提交（必須是新的、已重新審批的 tool call）在 `prepare` 遇到「`prepared` 且 `released_at` 有值」時，以 CAS 清空 `released_at` 並建立新的 tool execution；並行的兩個重新占用只有一個成功，另一個依原效果的新狀態判定為 `in_flight_duplicate`。同一列 business effect 保留，歷次嘗試都在 tool execution 留下紀錄。
- **與 Invariant 6 的關係**：重新占用只發生在使用者重新申請並重新審批時，不是自動重試；runtime 對已核准的 dispatch 仍是 `maxAttempts = 1`。
- **狀態表達**：`commit_state` 的值域與 `BusinessEffectCommitState` 型別**不變**；「已釋放」以 `released_at` 表達。讀取方的處理（T0 §6 盤點）：
  - ledger 的 `prepare` 與 `mapBusinessEffect`：新增 `releasedAt` 欄位並納入 claim 判定。
  - 取消判定：已釋放的效果搭配 failed 的執行，依既有 `deriveCancellationPhase` 落入 `read_only`（等同無效果），不需修改。
  - 備份與資料治理：只引用表名，不需修改。
- **舊版 instance 的行為**：看不到 `released_at`，會把已釋放的效果視為仍是 `prepared` 而回報未取得 claim。結果是舊版 instance 不會重新占用，但也不會重複執行；新版 instance 上線後即可重新占用。

### 6.9 加鎖順序一致

- 釋放（§6.8）、重新占用（§6.8）與提交（既有 `commitExecutionAndBusinessEffect`）都會在同一交易內同時寫 `business_effects` 與 `tool_executions`。
- 這三條路徑 MUST 以相同順序加鎖：**先 `business_effects`，再 `tool_executions`**（與既有 `prepare` 相同）。既有 `commitExecutionAndBusinessEffect` 目前是先更新 `tool_executions`、再更新 `business_effects`，T2 必須調整為一致順序（行為不變）。
- 以並行測試驗證：提交、釋放、重新占用三者對同一 business effect 並行時不發生資料庫死鎖，且狀態轉移只有一個成功。
- 背景見 §19 SI-1。

### 6.10 已消費的審批決策傳到 dispatch（S1）

第 9 版依 T2a 實作與 Master 決定更新本節（原文為「帶進 execution config」）。

- **傳遞方式**：gate 直接允許時的 decisionId，以及審批通過時已消費審批的 decisionId，寫入 `activeToolCall.authorizationDecisionId`（覆寫任何既有值）；`physical_dispatch` 以 `executeAuthorizedTyped` 的第三個型別參數 `ConsumedAuthorization` 交給 pipeline。**不經 execution config**：run config 的 `configurable` 可由客戶端帶入，BFF 只以黑名單擋已知欄位。
- **server 端驗證**：graph state 也可能被寫入（§6.13 關閉前，或未來出現新的寫入路徑），因此 decisionId 一律不被信任為識別字串。有副作用的預先授權 dispatch 在進入 runner 前，以 `PgConsumedAuthorizationVerifier` 對照 `permission_decisions` 與 `authorization_confirmations`：
  - 決策存在且 `effect = 'allow'`；principal、tenant、scope 與本次執行一致；
  - 有審批紀錄時：`approved`、已消費、`summary.toolName` 與本次 tool 相同、`toolCallId` 與本次 tool call 相同；
  - 沒有審批紀錄（gate 直接允許）時：決策紀錄的 `toolName` 與本次 tool 相同；
  - 驗證不通過、驗證器拋錯或沒有驗證器 → `rejected_before_dispatch`／`AUTHORIZATION_UNAVAILABLE`，記 audit `tool.authorization.decision_unverified`，不進 runner、不 claim。
- pipeline 驗證通過後以 `{ type: "authorized", decisionId }` 交給 runner；runner 在 claim 前完成授權（缺 decisionId 即拒絕），claim 後以既有 `linkAuthorizationDecision` 寫入 tool execution。
- 唯讀 tool 不驗證、也不轉交 decisionId（runner 唯讀路徑不使用）。
- 驗證只綁 tool 與 tool call，不綁輸入內容；輸入不被改寫由 §6.13 保證。

### 6.11 Schema 變更一律 additive，且新舊 instance 可並存（S6，第 7 版）

| 用途 | migration（只新增） | 既有欄位寫入的值 | 新版判定 | 舊版 instance 看到的 |
|---|---|---|---|---|
| 審批撤回（§6.2） | `authorization_confirmations` 新增 nullable `withdrawn_at TIMESTAMPTZ`、`withdrawn_by_principal_id TEXT` | `status = 'denied'` | `denied` 且 `withdrawn_at` 有值 → 已撤回 | 已拒絕，不可再消費 |
| claim 釋放（§6.8） | `business_effects` 新增 nullable `released_at TIMESTAMPTZ` | `commit_state = 'prepared'` | `prepared` 且 `released_at` 有值 → 可重新占用 | 進行中，回報未取得 claim，不會重複執行 |
| 未取得 claim 的執行（§6.5） | `tool_executions` 新增 nullable `claim_disposition TEXT CHECK (claim_disposition IN ('not_claimed'))` | `status = 'failed'`（原本寫 `unknown`） | `claim_disposition = 'not_claimed'` → 去重，不觸發 reconciliation | 失敗的執行，不會被當成結果未知 |
| reconciliation task（§6.6） | 新表 | — | — | 不讀取 |
| 操作摘要（§6.7，第 11 版） | 新表 `order_operation_requests` | — | — | 不讀取、不寫入；舊版 instance 建立的審批沒有摘要，查詢視為不存在（Master 2026-10-25 接受，階段性 review m2） |

- 所有 migration 只用 `ADD COLUMN IF NOT EXISTS` 或 `CREATE TABLE IF NOT EXISTS`，與既有 migration 017、022 相同；必須通過 `migration-additive` 檢查（不得出現 DROP／RENAME／ALTER COLUMN TYPE）。
- 新增欄位一律 nullable、無 default 值，舊版 instance 的寫入不受影響。
- 既有欄位只寫既有值；任何讀取既有欄位的舊版程式都不會遇到未知值。
- 「未取得 claim」改寫 `failed` 是既有欄位的既有值，舊版 instance 讀到時會視為失敗的執行，不會誤判。這改變了 `prepare` 對未取得 claim 的寫入值，但不改變 `failed` 的語意（不是成功、不可重用）。

### 6.13 客戶端不得直接寫入 graph state（S8／SI-5，第 9 版，Master 決策：納入 X43）

**問題**：審批、`activeToolCall`、`pendingAuthorization` 等授權相關資料都在 graph state，而客戶端可經 BFF 寫入 state（§2 S8）。只要能改寫 state，就能換掉已核准呼叫的輸入，或以 `goto` 跳過授權節點。§6.10 的 decisionId 驗證只能防偽造決策，防不了輸入被換。

**兩道防線**：

1. **BFF（邊界，主要防線）**：在既有的本文檢查（`containsUntrustedExecutionContext`、`validateInputKind`）旁新增一道「客戶端 state 寫入」檢查，於轉送前執行：

   | 請求 | 處理 |
   |---|---|
   | `POST /threads/{id}/state`（更新 state） | 拒絕 |
   | `POST /threads` 本文帶 `supersteps` | 拒絕 |
   | 任何本文（含批次陣列、crons）中的 `command` 含 `resume` 以外的欄位（`update`、`goto` 或其他） | 拒絕；同時帶 `resume` 也拒絕 |
   | 只含 `resume` 的 `command` | 照常轉送 |
   | 任何本文（含批次陣列、crons）中的 run `input` 頂層為物件且含 LangGraph 保留的序列化標記 `lg_name`（不論值；第 16 版，F1） | 拒絕 |
   | 以 POST 實作的唯讀請求：`/threads/{id}/history`、`/threads/{id}/state/checkpoint`、`/threads/search`、`/threads/count`、`/assistants/search`、`/assistants/count`、`/store/items/search`、`/store/namespaces` | 照常轉送 |
   | 一般 run 輸入（prompt、取消、deep_researcher 的設定欄位） | 照常轉送 |

   - 拒絕時回 HTTP 400，typed 錯誤碼 `CLIENT_STATE_WRITE_FORBIDDEN`，不轉送上游，記 audit（只記路徑樣式與被拒原因，不記本文）。
   - 路徑比對以「去掉 `/api/langgraph` 前綴後的 LangGraph 路由樣式」進行，`thread_id` 等參數以樣式比對，不寫死任何實際 ID。路由與欄位清單是 LangGraph API 1.4.5 的穩定協定常數，集中在一個具型別的清單並有測試；升級 LangGraph API 時 MUST 重新核對（記入 §14）。
   - 判斷以結構化解析的 JSON 進行；本文無法解析時沿用既有行為（交由上游驗證），不另行放寬或拒絕。
2. **graph（縱深防線）**：`shopping_assistant` 宣告獨立的輸入 schema（§4.2），只含 `messages`、`kind`、`targetRunId`。即使 BFF 檢查遺漏或出現新的寫入路徑，run 輸入也無法寫入審批、tool 佇列、操作狀態等內部 state。
3. **graph 入口拒絕 Command 表示（第 16 版，F1；Master 2026-10-27 確認）**：
   - **問題**：LangGraph 以 `lg_name` 辨識 Command，也接受 JSON 的一般物件。run `input` 只要寫成 `{"lg_name": "Command", "update": …, "goto": …}`，就會被當成 Command 執行。它的 `update` 不受輸入 schema 限制，`goto` 也能跳過授權節點，第 1、2 道防線都被繞過（Codex S1～S8 核對 F1，`evidence/codex-review-s1-s8.md`）。
   - **規則**：共用 graph 入口 `instrumentGraphWithExecutionContext` 在呼叫 graph 前檢查輸入：
     - 頂層為一般物件且含 `lg_name` → 拒絕，typed `CLIENT_STATE_WRITE_FORBIDDEN`，不呼叫 graph。
     - 是 `Command` 實例（LangGraph API 由外層 `command` 建立）但帶有 `resume` 以外的欄位（`update`、`goto`、`graph`）→ 拒絕。
     - 只含 `resume` 的 `Command` 實例 → 照常執行。
   - **適用範圍**：所有經共用入口的 graph（`shopping_assistant`、`mcp_agent`、`deep_researcher`，以及經共用入口包裝時的 `math_agent`）。BFF 的檢查本來就涵蓋所有 graph；只要 graph 入口有一處遺漏，同類繞過就會重現。各 graph 的輸入 schema 仍維持「不在本次範圍」。
   - **替代方案**：只在 `shopping_assistant` 檢查。不採用，理由是 `mcp_agent` 同樣使用 confirmation 節點，F1 對它同樣成立。

**不在本次範圍**：既有 graph（`mcp_agent` 等）的輸入 schema；BFF 以外直接連 LangGraph API 的路徑（compose 只對外公開 BFF）；`/assistants` 建立或修改時夾帶的 config（decisionId 不再從 config 讀取，§6.10）。

**相容性**：前端只使用 prompt／取消輸入與 `command.resume`（T0 §13），既有行為不變；任何依賴 state 寫入端點的工具（例如 LangGraph Studio 經 BFF 連線）會被拒絕，屬預期行為。

### 6.14 審批 resume 以伺服器端記錄的等待中 run 綁定（S9，第 12 版，Master 決策：方向 A；第 13 版修訂第 1、3 點）

**問題**：Agent Server 為每個請求建立新的 run 並覆寫 `configurable.run_id`（§2 S9）。tool 審批的 resume 一定由新 run 承載，而 `consume` 要求承載 resume 的 run 等於審批描述記錄的原 run，經 Agent Server 的核准因此必定失敗。主規格 `trusted-tool-authorization` 與 `durable-hitl-conversation-recovery` 要求「mismatched-Run 必須拒絕」，但沒有定義比對的是哪一個 run；第 12 版以 MODIFIED delta 明確定義（`specs/trusted-tool-authorization`、`specs/durable-hitl-conversation-recovery`）。

**決策（方向 A，Master 2026-10-25）**：「等待中的 Run」以伺服器端保存的 waiting state 為準，承載 resume 的 run 不參與比對。作法與天氣澄清 resume 以伺服器端權威 correlation 綁定一致。

1. **confirmation 節點（`authorization_confirmation`）**：沿用既有檢查，即依 checkpoint 中的 `pendingAuthorization` 推導 interruptId、取得 manifest，並比對 manifest 的 runId／taskId／stepId／scope／decisionRef 與審批描述一致、execution manifest 相容。兩者都是伺服器端紀錄，這就是「等待中 Run」的綁定。上述既有檢查不符時，維持拋出「manifest 不可用或不相容」錯誤（不變）。
   第 13 版修訂（Master 2026-10-26 決策：方案 1，見 `evidence/tr-inventory-and-stop.md` §2）：新增的兩項檢查**不拋錯**，改為回傳 typed failure 並記 audit，且不 consume、不 dispatch：
   - manifest `status` 不是 `waiting` → 結束該 tool call，tool message `errorCode: CONFIRMATION_REPLAYED_OR_EXPIRED`；
   - 承載 resume 的 execution context 的 `threadId` 不等於審批描述（與 manifest）的 `threadId` → `errorCode: CONFIRMATION_BINDING_MISMATCH`。
   - 兩者都記 `authorization.confirmation.rejected`（`decisionId`、`reasonCode`、`waitingRunId`、`resumeRunId`），與 `consume` 的拒絕使用同一事件名稱與欄位。
   - 結束方式與 `consume` 回傳非核准結果相同：清除 `activeToolCall` 與 `pendingAuthorization`；有開啟 `confirmationOutcome` 的 graph 沿用 `resolveConfirmationOutcome`（非 `waiting` 時依 `findStatus` 判定 withdrawn／expired／denied，已核准的紀錄不寫 outcome），不另訂新的 outcome 值，也不轉移 manifest 狀態。
   - 兩項檢查在呼叫 `interrupt()` 之前執行；第一次進入節點時 manifest 剛建立且為 `waiting`、thread 一致，因此只影響 resume 後的重跑。
   **改為 typed failure 的理由**：核准、拒絕、逾期、撤回後 manifest 都已離開 `waiting`，依序重放必定落在這條路徑；若拋錯，重放會從既有的 typed failure（`CONFIRMATION_REPLAYED_OR_EXPIRED`）變成 run 失敗，且拋錯路徑沒有 audit，與 MODIFIED delta 的「MUST 拒絕並 audit」不一致。
2. **`consume` 的綁定**：移除「execution context 的 runId 等於審批描述的 runId」，改為「execution context 的 threadId 等於審批描述的 threadId」。approvalId、decisionId、scope（scopeId、scopeType、tenant）、resource 的 tenant 與允許審批人的檢查不變。SQL 的單列 CAS 繼續以審批描述的 runId 比對資料表的 `run_id`（兩邊皆為伺服器端紀錄），一次性消費與逾期判定不變。這個比對就是「等待中 Run」的資料庫層綁定，**MUST NOT 移除或改為比對承載 resume 的 run**：只有應用層比對的是承載 resume 的 run，所以只移除應用層那一處。
3. **audit**：`authorization.confirmation.consumed` 與 `authorization.confirmation.rejected` 新增 `waitingRunId`（審批描述的 runId）與 `resumeRunId`（承載 resume 的 runId）兩個欄位，使兩個 run 可互相追溯。只放 audit 與 trace attribute，不作 metric label（既有 Requirement）。不記 `approvalId`（一次性憑證）。
   第 13 版補充（實作前核對發現的既有缺口）：production 組裝（`createRuntimeToolAuthorizationComposition`）建立 `PgAuthorizationConfirmationStore` 時沒有傳入 audit sink，預設為 no-op，因此 `authorization.confirmation.*` 在 production 從未落地，delta 的 MUST audit 實際不成立。TR 一併修正：
   - production 的審批儲存與 confirmation 節點都注入同一個 audit sink，接到既有的 `auditLogger`（`PgAuditLogger.record` 會吞下寫入錯誤，只記 `audit_persistence_failed`）；
   - `createToolAuthorizationGraphNodes` 新增選填的 confirmation audit sink 依賴，未提供時為 no-op（與 `PgAuthorizationConfirmationStore` 現行預設一致，既有測試替身不需修改）；`mcp_agent` 與 `shopping_assistant` 的 production 組裝 MUST 提供；
   - 節點層 audit 失敗不得改變結果（拒絕仍是拒絕），以 `.catch` 隔離。
   - 不新增資料表或 migration；audit 事件寫入既有 audit 儲存。
4. **不變的部分**：
   - 不新增資料欄位或 migration；不改 harness resume schema；不改 BFF。
   - active-run hint 仍只供 governance 推進 generation，不參與審批綁定；客戶端提供的任何 run 識別都不影響核准結果。
   - 撤回（§6.2）本來就不要求 runId 相同，不變。天氣澄清 resume 以 active run ownership 綁定，也不變。
5. **dispatch 之後**：核准後的 dispatch 在承載 resume 的 run 中執行。`PgConsumedAuthorizationVerifier` 只綁 principal、tenant、scope、tool 與 toolCallId，不綁 runId（已核對，§6.10），不需修改。理由是兩者職責不同：verifier 確認 dispatch 拿到的 decisionId 是伺服器端真實、已核准且屬於這個 tool call 的決策；run 與 thread 的綁定已在 confirmation 節點與 `consume` 完成，dispatch 時不需要也不應重做。ledger 的 tool execution 記錄承載 resume 的 run，再經 decisionId 連到審批紀錄與原 run（§6.7 的既有連結），不新增對照表。
6. **共用範圍**：綁定邏輯位於共用的授權節點與審批儲存，`shopping_assistant` 與 `mcp_agent` 同時修正（Master 決策：`mcp_agent` 直接納入），不另設 opt-in。`mcp_agent` 的 tool 只要 risk tier 為 `sensitive`／`communication` 或宣告 `requireConfirmation` 就會走到此路徑；目前實際設定了哪些 tool 未逐一盤點；TR 實作前先唯讀盤點並記入 evidence，再以回歸測試涵蓋整條路徑。

**為什麼移除 run 相等不會放寬授權**：
- 承載 resume 的 run 永遠是新的，「與原 run 相等」對真實請求沒有任何區分力，只會讓所有核准失敗。
- resume 只能套用到該 thread checkpoint 中等待中的 interrupt；審批描述來自伺服器端 checkpoint，客戶端無法寫入（§6.13 的 BFF 檢查與 graph 輸入 schema）。
- thread 綁定擋下跨 thread 的 resume。approvalId（256 bit）不能單獨授權，仍需 trusted principal 在允許清單內，且 tenant／scope 一致。
- 單列 CAS 保證只消費一次：重放、撤回後核准、逾期後核准都維持既有 typed failure。

**測試要求**：interrupt 與 resume MUST 使用不同的 run 識別，模擬 Agent Server 的實際行為（既有測試讓兩者共用同一個 runId，正是 S9 未被發現的原因）。必須涵蓋以下情境：
- 由新 run 承載的核准只 dispatch 一次；
- 不同 thread 的 resume 被拒；
- 承載 resume 的 run 等於或不等於原 run 都不影響結果；
- manifest 非 `waiting` 時回傳 typed failure、不呼叫 `consume`（第 13 版）；
- 重放回傳 `CONFIRMATION_REPLAYED_OR_EXPIRED` typed failure（第 13 版：依序重放由節點的 `waiting` 檢查攔下，並發重放由 `consume` 的 CAS 攔下，兩者結果相同）；
- 撤回後、由新 run 承載的核准被拒；
- 逾期後、由新 run 承載的核准被拒；
- principal 不在允許清單時被拒；
- audit 帶兩個 run 識別，節點層拒絕也有 audit（第 13 版）；
- production 組裝的審批儲存與 confirmation 節點使用真實 audit sink，而非 no-op（第 13 版）。

以上在 `shopping_assistant` 與 `mcp_agent` 各做一次，並以真實 Postgres 執行，同時補上階段性 review m3 的 `mcp_agent` 審批路徑 Postgres 回歸。經 BFF 與真實 Agent Server 的審批 resume 至少執行一次 smoke（T9）。

### 6.15 Graph 入口登記 task，resume 接回原 task（S10，第 14 版，Master 決策：納入 X43）

**問題**（T9 live smoke 發現，`evidence/t9-live-smoke-stop.md`）：`shopping_assistant` 的正式入口以 `readExecutionContext` 直接讀取 BFF trusted header 建立 execution context，但 `taskId` 不在 header 中，也沒有任何地方產生或登記；Agent Server 與 BFF 都不提供 `taskId`。經真實 Agent Server 的每次請求都在入口以 `ZodError`（`taskId` Required）失敗，意圖判斷、審批與 dispatch 都沒有執行（fail-closed，沒有副作用）。`mcp_agent` 已以 live 請求確認同樣失敗（`evidence/s10-mcp-agent-probe.json`）。

既有測試沒有暴露的原因：測試直接在 `configurable.execution_context` 帶入完整 context，整合測試另外預先插入 `agent_tasks`／`task_steps`；D3 live gate 為主機單一程序直接呼叫 graph，沒有經過 BFF 與 Agent Server。

**決策**（Master 2026-10-26，原話）：「S10 納入 X43：退回 PLAN_DRAFT，由 CCR 補 design 與 tasks（shopping 入口改用 graph-entry task admission、state 保存 executionTaskId）。mcp_agent 先用 live 請求確認是否受影響，再決定要不要納入。」

**作法**：沿用 `deep_researcher` 已在使用的 graph 入口機制（`createGraphEntryContextResolver` 與 `PgGraphTaskAdmission`），不另造新的 task 登記方式。第 1～5 點以 `shopping_assistant` 說明，`mcp_agent` 採相同作法，差異見第 6 點。

1. **入口登記 task**：`shopping_assistant` 的 `instrumentGraphWithExecutionContext` 改用 `createGraphEntryContextResolver(已編譯的 graph, new PgGraphTaskAdmission())`。
   - 新的使用者輸入：入口產生候選 taskId，由 `PgGraphTaskAdmission.admit` 寫入 `agent_tasks`（`task_type = 'graph_execution'`，`metadata.graphEntry` 記錄 initial run、thread、principal、tenant、scope），之後所有節點讀到的 execution context 都帶這個 taskId。
   - 同一個 run 重複進入入口時，以 `graphEntry.initialRunId` 找回同一筆 task，不重複登記（既有行為）。
   - `createGraphEntryContextResolver` 目前固定以 `NODE_ENV`／`EXECUTION_CONTEXT_DEV_ENABLED` 判斷是否使用開發用 context；shopping 現在以 `TOOL_AUTHORIZATION_PROFILE` 判斷。為了不改變 shopping 的開發路徑，`createGraphEntryContextResolver` 新增**選填**的 context reader 參數，未提供時維持現行判斷（`deep_researcher` 行為不變），shopping 傳入與現行 `resolveShoppingExecutionContext` 相同的判斷。
2. **State 保存 `executionTaskId`**：shopping state 新增 `executionTaskId`（§4.2），由 `route_intent` 在每輪開始時寫入入口登記的 taskId，與 `deep_researcher` 在新一輪重設時寫入的方式相同。
   - 只能由節點寫入：不加入輸入 schema（§6.13），run 輸入夾帶時 MUST 不影響 state。
   - cancel 輸入（`kind: "cancel"`）不經過 `route_intent`，不覆寫 `executionTaskId`；撤回以審批紀錄中的 task 為準（§6.2、`withdraw` 的 SQL 以審批紀錄的 `task_id` 更新），與 cancel run 登記的 task 無關。
3. **resume 接回原 task**：resume（`Command` 或 null 輸入）時，入口從 checkpoint 讀取 `executionTaskId`，`PgGraphTaskAdmission` 以該 task 查詢並驗證 thread、principal、tenant、scope 與登記時一致，才回傳同一個 taskId；不一致或找不到時拋錯（既有行為）。
   - 這與 §6.14 一致：登記時的 initial run 只作為 task 的建立紀錄，resume 的比對對象是伺服器端保存的 task，不比對承載 resume 的 run。
   - checkpoint 沒有 `executionTaskId` 時（例如本變更前建立的 checkpoint），resume MUST fail-closed（`executionIdSchema` 驗證失敗），不另建新 task。本變更前的 production 入口一律失敗，因此不存在可正常 resume 的舊 checkpoint。
4. **step 與外鍵**：`interrupt_manifests.task_id` 參照 `agent_tasks`（入口登記後成立）；`step_id` 參照 `task_steps`（可為空）。production 的 `stepId` 由 tool 呼叫路徑產生（`createToolCallContext`、dispatch pipeline 的 task-step adapter），是否在寫入 manifest 前已建立對應的 `task_steps` 尚未核對。實作前 MUST 先唯讀盤點；整合測試 MUST 走真實的入口登記，不預先插入 `agent_tasks`／`task_steps`。若發現外鍵不成立或需要新增 step 的建立點，停止並回報，不得以預先插入資料或放寬外鍵處理。（第 15 版：盤點已完成，審批前 `stepId` 為空、外鍵成立；核准後 dispatch 需要 `stepId`，由 §6.16 處理。）
5. **不變的部分**：不新增資料表或 migration（`agent_tasks` 與 `graph_execution` task type 既有）；不改 BFF、harness、審批綁定（§6.14）與 task 狀態生命週期；入口登記失敗時整個請求 fail-closed，不退回無 taskId 的執行。
6. **`mcp_agent`**（Master 2026-10-26 決策，原話：「mcp_agent 納入 TE，用相同的入口登記與 executionTaskId 做法。」）：已以 live 請求確認受影響（`evidence/s10-mcp-agent-probe.json`），作法與 shopping 相同：
   - 入口改用 `createGraphEntryContextResolver(已編譯的 graph, new PgGraphTaskAdmission())`，context reader 沿用現行 `resolveMcpExecutionContext` 的 `TOOL_AUTHORIZATION_PROFILE` 判斷。
   - `mcp_agent` state 新增 `executionTaskId`，由 `call_model` 寫入入口登記的 taskId。新的輸入一律從 `START` 進入 `call_model`，審批 interrupt 發生在其後的 `authorization_confirmation`，因此等待中的 checkpoint 一定保存伺服器端的值；resume run 中再次執行 `call_model` 時，入口已接回原 task，寫入的值不變。
   - `mcp_agent` 沒有宣告輸入 schema（§14 既有 Retrofit Debt），run 輸入可能夾帶 `executionTaskId`；該值 MUST 在 `call_model` 被入口登記的 taskId 覆寫，以測試固定。即使被利用，resume 時 `PgGraphTaskAdmission` 仍會驗證 task 的 thread、principal、tenant、scope，無法接上其他 principal 或其他 thread 的 task。
7. **部署對齊**（第 13 版 T9 前置，Master 擴大 writeScope 後已修改、尚未 commit）：手寫 Dockerfile 依 `backend/langgraph.json` 補上 `shopping_assistant` graph、`LANGGRAPH_HTTP`（operations http app 與 `configurable_headers`，否則 BFF 的身分與 active-run header 不會進入 graph config）與前端 build 需要的 `contracts/`。S10 的修正不需要再改 Dockerfile。

**測試要求**：
- 入口（兩個 graph）：新的使用者輸入會登記一筆 `graph_execution` task，execution context 帶該 taskId；同一 run 重複進入不重複登記；入口登記失敗時請求 fail-closed。
- resume：由新 run 承載的 resume 取得與等待中相同的 taskId；thread、principal、tenant 或 scope 不一致時拒絕；checkpoint 缺 `executionTaskId` 時 fail-closed。
- State：shopping 的 `executionTaskId` 由 `route_intent` 寫入，run 輸入夾帶時不影響 state，cancel 輸入不覆寫；`mcp_agent` 的 `executionTaskId` 由 `call_model` 寫入，run 輸入夾帶的值在進入審批前被覆寫。
- 開發路徑：兩個 graph 在 `TOOL_AUTHORIZATION_PROFILE=development` 下的行為與修改前相同；`deep_researcher` 的入口行為不變。
- 真實 Postgres 整合測試走 `PgGraphTaskAdmission` 與 `PostgresSaver`，**不預先插入** `agent_tasks`／`task_steps`，`shopping_assistant` 與 `mcp_agent` 各一組，涵蓋「入口登記 → 審批 interrupt → 新 run 承載 resume → dispatch 一次」，同時驗證 manifest 外鍵。
- T9 live smoke 在本節完成後重新執行。

### 6.16 核准後 dispatch 以確定性 stepId 執行（S11，第 15 版，Master 決策：方案 A）

**問題**（TE 第 1 項盤點發現，`evidence/te-inventory-and-stop.md`）：shopping 的 tool 一律經 dispatch pipeline（§5.4），pipeline 在 dispatch 前要求 canonical context 帶 `stepId`，缺少時回 `TOOL_EXECUTION_CONTEXT_UNAVAILABLE`；task-step adapter 也依 `stepId` 建立與推進 `task_steps`。共用授權節點的 `physicalDispatch` 只在 context 加入 `toolCallId`，production 沒有任何地方產生 `stepId`。§6.15 修正入口後，核准仍會在 dispatch 前被拒，訂單系統不會被呼叫（fail-closed）。測試直接帶入 `stepId: "step-1"`，因此沒有暴露。

**決策**（Master 2026-10-26，原話）：「S11 納入 X43，採方案 A：共用 physicalDispatch 用 createToolCallContext 的確定性做法產生 stepId，gate 不設定，mcp_agent 一併適用。請退回 PLAN_DRAFT 補 design 與 tasks。」

**作法**：

1. **`physicalDispatch` 產生 `stepId`**：呼叫 `executeAuthorizedTyped` 前，以 `createToolCallContext` 相同的確定性摘要（`createRawInputReference`：穩定序列化後的 SHA-256）產生 `stepId = step-<digest>`，摘要內容為 `{ taskId, nodeName: "physical_dispatch", toolName, toolCallId, input }`，寫入傳給 dispatch 的 execution context。
2. **與 `createToolCallContext` 的兩點差異**（刻意，非偏離決策）：
   - **不覆寫 `toolCallId`**：`createToolCallContext` 會以摘要產生新的 `toolCallId`，但 shopping 的 `operations`、審批紀錄、ledger 與 tool message 都以模型給的 `call.toolCallId` 為鍵，覆寫會讓核准結果對不上原本的操作。因此只產生 `stepId`，`toolCallId` 沿用 `call.toolCallId`。
   - **摘要納入 `toolCallId`**：`createToolCallContext` 的摘要不含 tool call 識別；同一 task 內兩個輸入相同的 tool call（例如同一則模型訊息兩次相同退款）會得到相同 `stepId`，task-step adapter 會把第二次視為已完成的 step。納入 `toolCallId` 後，不同 tool call 一定得到不同 `stepId`。
   - 摘要邏輯以新的輔助函式放在 `tool-call-context.ts`，與 `createToolCallContext` 共用同一個摘要方式；`createToolCallContext` 本身不修改，`deep_researcher` 的行為不變。
3. **gate 不設定 `stepId`**：審批前不產生 `stepId`，審批紀錄與 manifest 的 `step_id` 維持 null。理由：`interrupt_manifests.step_id` 有外鍵參照 `task_steps`，而 step 要到 dispatch 時才由 task-step adapter 建立；若在 gate 設定，manifest 會指向尚未存在的 step。審批與 dispatch 之間仍以 `decisionId` 與 `toolCallId` 連結（§6.7、§6.10 既有）。
4. **確定性與重放**：taskId 由 §6.15 的入口接回原 task，`toolCallId`、`toolName`、輸入都來自 checkpoint 中已核准的 tool call，因此同一個核准在 run 重試或重放時得到相同 `stepId`；task-step adapter 遇到已存在的 step 依既有規則略過或維持冪等，與 ledger 的單次 claim 一致。
5. **context 不完整時 fail-closed**：`physicalDispatch` 取得的 canonical context 缺少 taskId 時，維持既有行為（`readExecutionContext` 拋錯或 pipeline 回 `TOOL_EXECUTION_CONTEXT_UNAVAILABLE`），**不得**退回 `createToolCallContext` 的隨機識別或以節點名稱當作 `stepId`。
6. **`mcp_agent`**：使用同一個共用節點，一併適用。`mcp_agent` 是否經 pipeline 由 `TOOL_DISPATCH_PIPELINE_MCP_ENABLED` 決定（預設關閉，`registry.ts:75-80`）：關閉時 governed executor 只把 `stepId` 用於 audit 與 trace；開啟時與 shopping 相同，`stepId` 為 dispatch 的必要條件。
7. **不變的部分**：不新增資料表或 migration；不改 BFF、harness、pipeline、task-step adapter、gate 的授權與 §6.14 的審批綁定。

**測試要求**：
- 同一個 task、tool call 與輸入得到相同 `stepId`；不同 `toolCallId`（輸入相同）得到不同 `stepId`；`toolCallId` 維持 `call.toolCallId`。
- gate 階段不設定 `stepId`：審批紀錄與 manifest 的 `step_id` 為 null。
- context 缺少 taskId 時 fail-closed，不產生隨機 `stepId`。
- `createToolCallContext` 的既有行為與 `deep_researcher` 的測試不變。
- 真實 Postgres 整合測試（與 §6.15 合併）：不預先插入 `agent_tasks`／`task_steps`、context 不帶 `stepId`，經 shopping 的 pipeline 核准後 dispatch 一次，task-step adapter 建立對應 `task_steps`，訂單 provider 只被呼叫一次；重放不再 dispatch。
- `mcp_agent`：`TOOL_DISPATCH_PIPELINE_MCP_ENABLED` 開啟與關閉兩種情況，核准後都 dispatch 一次。

## 7. 操作生命週期

```text
requested ─▶ awaiting_approval ─┬─▶ approved ─┬─▶ executing ─┬─▶ confirmed
                                 │              │              ├─▶ failed
                                 │              │              └─▶ outcome_unknown
                                 │              └─▶ cancelled_before_effect
                                 ├─▶ approval_denied
                                 ├─▶ approval_expired
                                 └─▶ cancelled_before_effect
（任一提交）─▶ deduplicated（指向原操作與其狀態）
```

- Enum 單一來源 `OrderOperationState`（backend Domain Constant），前端以同名 Transport Enum 驗證，未知值安全降級。
- terminal：`confirmed`、`failed`、`approval_denied`、`approval_expired`、`cancelled_before_effect`、`deduplicated`（就本次提交而言）。`outcome_unknown` 對使用者是穩定狀態，只能由 X31 reconciliation 推進。
- terminal 狀態不得回到非 terminal；`requested`、`approved` 不得顯示為 `confirmed`。
- v6 Invariant 9（requested、pending=awaiting_approval、approved、executing、confirmed、failed、outcome_unknown）與 v7 七種狀態（awaiting_approval、executing、confirmed、deduplicated、failed、cancelled_before_effect、outcome_unknown）皆被涵蓋且可區分；另加 `approval_denied`、`approval_expired` 兩個獨立 terminal。

## 8. 事件族與版本

### 8.1 沿用契約與新增 producer

- 既有 Tool、permission／interrupt、Run／Task／Step、terminal 事件族不變。
- 沿用既有 `card.emit` envelope（legacy `agent.card.emit`）與前端解析；`cardType` 為字串，payload 自帶 `schemaVersion`。
- **backend 目前沒有 `card.emit` producer**（T0 S4）：X43 新增 backend 發送路徑，事件型別、envelope 與前端解析都沿用既有契約，不改 `runtime-event-contract`。
- **發送路徑（第 8 版，S7-a）**：前端 `extractIncomingRuntimeEventResults` 從每個 update chunk 的頂層與各 node 值讀 `runtimeEvents` 陣列，因此 shopping graph 以 **node 的 state update 回傳 `runtimeEvents`** 發送，不新增串流機制、不改 BFF：
  - state 新增 `runtimeEvents` channel（§4.2）：reducer 為「每次 update 取代」，只承載該 node 本次發出的 envelope，不累積；checkpoint 只存最後一次的少量 envelope，內容只含識別碼與 Enum（§10）。
  - envelope 以 server 端 execution context 填 `context`（`runId` MUST 為本次 run；前端會丟棄不是 active run 的事件）。
  - `sequence`：前端緩衝（`frontend/src/lib/runtime-event-envelope.ts`）對每個 runId 從 1 開始、要求連續，缺號的事件會被暫存到補齊或超出重排視窗才送出，`eventId` 重複即丟棄。因此 graph MUST 在 state 保存 `runtimeEventCursor: { runId, nextSequence }`：runId 與目前 run 不同時從 1 重新開始，每發出一個 envelope 加 1；`eventId` 由 runId 與 sequence 推導，replay 時相同。目前 backend 沒有其他 envelope producer，此計數是該 run 唯一的序號來源。
  - 前端只對 `showActivityTimeline` 為 true 的 agent 處理這些事件，因此 `shopping_assistant` 的 agent 項目 MUST 設為 true（§11）。
  - `VITE_RUNTIME_EVENT_ENVELOPE_ENABLED` 為 false 時前端把它們當 legacy 值忽略，卡片不顯示、對話仍正常；這是既有開關的既有語意，不另外處理。
- T9 必須證明該事件經 BFF 原樣透傳到前端，並以真實串流確認 update chunk 帶有 `runtimeEvents`。

### 8.2 新增 card payload

| cardType | payload schemaVersion | 欄位 | 發出者 |
|---|---|---|---|
| `product_result` | `product_result@1` | `citationId`、`sourceId`、`sourceVersion`、`title`、`snippet`（截斷） | `product_present` |
| `order_operation_status` | `order_operation_status@1` | `operationRef`（`toolCallId`、`operationId?`）、`kind`、`orderRef`、`state`、`stateVersion`（單調遞增）、`approvalExpiresAt?`（server 提供）、`reasonCode?`、`dedup?`、`reconciliationTaskId?` | `order_request` 後（`requested`）、審批前後、`order_present` |

- machine 欄位不放使用者可見標籤；前端以 Enum 映射繁中標籤。
- 前端以 `(operationRef.toolCallId, stateVersion)` 去重與排序；收到較舊版本或 terminal 後的非 terminal 狀態 MUST 忽略。
- 未知 `cardType` 或 payload 驗證失敗 → 通用安全降級（既有時間軸列），不中斷串流。
- 不新增 runtime event type；reconciliation task 以 card 欄位與 audit 呈現（不新增 `reconciliation.*` 事件，避免修改 `runtime-event-contract`）。

## 9. Typed Failure Taxonomy（新邊界）

| 邊界 | 碼（暫定，T0 對齊既有慣例，語意不得改變） | 對應狀態 |
|---|---|---|
| 意圖路由 | `INTENT_ROUTING_SCHEMA_INVALID`、`INTENT_ROUTING_PROVIDER_ERROR`、`INTENT_ROUTING_CANCELLED` | `clarify` 或 Run 取消 |
| 訂單 tool 輸入 | `ORDER_INPUT_INVALID`（schema，含夾帶身分／審批欄位） | `failed`（dispatch 前） |
| 訂單業務規則 | `ORDER_NOT_FOUND`（含非本人訂單）、`ORDER_NOT_ELIGIBLE`、`ORDER_OPERATION_ALREADY_EXISTS`（業務規則防線；只在 scope 比 tenant 細時有驗收情境，§13 Q2） | `failed`（未提交） |
| provider（dispatch 前） | `ORDER_PROVIDER_UNAVAILABLE` | `failed`（未提交） |
| provider（dispatch 後） | `ORDER_PROVIDER_TIMEOUT`、`ORDER_PROVIDER_RESPONSE_LOST` | reconciler → `confirmed`／`failed`／`outcome_unknown` |
| 審批 | 既有 `CONFIRMATION_TIMEOUT`、`CONFIRMATION_BINDING_MISMATCH`、`CONFIRMATION_REPLAYED_OR_EXPIRED`；新增 `CONFIRMATION_ALREADY_DECIDED`（撤回時已被決定）；新增機器欄位 `confirmationOutcome`（opt-in） | `approval_expired`／`cancelled_before_effect`／typed failure |
| 取消與撤回 | `CONFIRMATION_WITHDRAW_FAILED`（撤回寫入失敗，保留可重試狀態）；沒有等待中的審批時為非錯誤的 no-op 回覆 | `awaiting_approval`（失敗）／不變（no-op） |
| dispatch 就緒預檢 | `ORDER_DISPATCH_NOT_READY`（pipeline、ledger 或 confirmation store 不可用；不建立審批） | `failed`（未提交） |
| ledger | 既有 `SIDE_EFFECT_LEDGER_UNAVAILABLE`、`SIDE_EFFECT_REPLAY_CONFLICT`、`SIDE_EFFECT_RECONCILIATION_REQUIRED` 等 | `failed`／`outcome_unknown` |
| reconciliation task | `RECONCILIATION_TASK_PERSISTENCE_FAILED` | 仍為 `outcome_unknown` |
| reconciliation 確認未提交（T2a） | `SIDE_EFFECT_NOT_COMMITTED`（claim 已釋放，不自動重試） | `failed` |
| 預先授權的決策無法驗證（§6.10） | 既有 `AUTHORIZATION_UNAVAILABLE`（dispatch 前拒絕，audit `tool.authorization.decision_unverified`） | `failed`（未提交） |
| BFF 客戶端 state 寫入（§6.13） | `CLIENT_STATE_WRITE_FORBIDDEN`（HTTP 400，不轉送） | — |
| 狀態查詢 | `ORDER_OPERATION_NOT_FOUND` | — |
| 前端 card | `invalid_payload`（前端內部，`UnsupportedCardReason`） | 安全降級 |

- provider error 不得轉成 not found；授權拒絕、逾時、審批 deny 不進入 retry（既有 `trusted-tool-authorization`）。

## 10. 資料分級與資料治理

| 產物 | 位置 | 分級（暫定，T0 對齊既有 data inventory 值） | 治理 |
|---|---|---|---|
| 合成訂單 fixture | repo 資料目錄，provenance header 標註 synthetic | `commerce:internal-synthetic` | 非個資；不進 knowledge store |
| 模擬 provider 狀態 | in-memory | 同上 | 程序結束即消失；不登記 data inventory（無持久化） |
| reconciliation task | runtime Postgres 新表 | 與 business effect ledger 相同的營運紀錄分級 | 登記 data inventory；只存識別碼，不存 note 或自由文字 |
| 操作摘要 `order_operation_requests` | runtime Postgres 新表 | 與審批紀錄相同的營運紀錄分級 | 登記 data inventory；只存識別碼與 Enum，不存 note、reasonCode 或自由文字 |
| ledger、審批決策 | 既有表；新增 nullable 欄位 `withdrawn_at`、`withdrawn_by_principal_id`、`released_at`、`claim_disposition`（§6.11） | 既有 | 分級與保存不變；`withdrawn_by_principal_id` 是 principal 識別，與既有 `principal_ids` 欄位同等處理 |
| card payload | 串流事件 | 不含個資；`note` 不進 card | — |
| `turnEvidence`／`operations` state | checkpoint | 只存識別碼與 Enum | 既有 checkpoint redaction |

- 訂單 `note` 只作為 tool input 傳給模擬 provider，不寫入 card、event 或 reconciliation task。

## 11. Frontend

- agent 清單新增 `shopping_assistant`（`AgentId` Enum 與 `AVAILABLE_AGENTS` 為單一來源），`showActivityTimeline: true`（既有事件處理只對此類 agent 執行，§8.1）。卡片元件由同一條事件處理路徑取得 payload，不另建傳輸。
- `ProductResultCard`：顯示標題、片段與引用標記；引用可對應回答中的 citationId。
- `OperationApprovalCard`：`awaiting_approval` 時顯示操作摘要（種類、訂單、明細）、server 提供的審批期限與「核准」「拒絕」「取消申請」。核准／拒絕以既有 resume 機制回傳；前端已知 active run 識別時才帶上，未知不帶，審批綁定一律以服務端記錄的等待中 run 為準（§6.14），最終結果以服務端為事實來源（Master 2026-10-26 裁定，T10）；取消申請送出既有 `cancel` 輸入（`targetRunId` 為審批所屬的 run），狀態以 graph 回傳的 card 為準。撤回失敗時顯示 typed 錯誤並允許重試取消。送出期間按鈕停用，避免重複送出。
- 期限已過但尚未收到 server 的逾期狀態時，卡片只顯示「已超過審批期限，系統確認中」的提示並保留按鈕；**不得**自行把狀態改為 `approval_expired`。使用者送出後，由 server 回傳逾期結果。
- `OperationStatusCard`：依 `order_operation_status@1` 顯示所有生命週期狀態的繁中標籤與說明；`outcome_unknown` 顯示「結果待確認，已建立核對工作，請勿重複申請」；`deduplicated` 顯示「與既有申請相同，未重複執行」並連到原操作狀態。
- **沒有 undo、撤銷、退款取消或「復原」按鈕**；`confirmed` 之後不提供任何操作按鈕。測試以查詢可操作元素驗證。
- 狀態 reducer：以 `(operationRef.toolCallId, stateVersion)` 單調前進；terminal 後忽略非 terminal；未知 state 以通用降級呈現，不推測。
- 不在 UI 層推測後端語意，不以顯示文案反推狀態。
- 介面標註「模擬訂單操作（mock）」，遵守 v7 External Description Boundary。

## 12. BFF

- **第 9 版起 BFF 有一項正式程式變更**：§6.13 的客戶端 state 寫入檢查（`client-graph-state-boundary` delta，tasks TS）。除此之外，既有 LangGraph proxy 應可透傳 `shopping_assistant` 請求、trusted identity header、interrupt resume 與 `cancel` 輸入（前端以一般 run 輸入送出，§6.2），這仍是**未驗證的假設**。
- 驗證方式：在 bff 既有測試目錄新增測試檔，以既有 `npm run test` 執行（`bff/package.json` 已有 vitest 與 node test 入口）。除 §6.13 以外，若需要修改 bff 的正式程式碼或 `package.json`，即停止並退回補 delta。
- 風險點（第 12 版更正）：原假設「審批 `consume` 必須靠 active run 識別 header 延續原 run」不成立。Agent Server 的 resume 一定是新的 run，綁定問題在 backend，不在 BFF（§2 S9），改由 §6.14 處理，BFF 不需修改。
- T9 以整合測試證明 BFF 的傳輸行為：resume 與 `cancel` 的本文和 active-run header 原樣送到原 thread、`card.emit` 原樣透傳、client 注入的身分 header 被 strip、取消與斷線透傳不變（已由 `bff/test/shopping-passthrough.test.mjs` 證明，2026-10-25）。「核准通過審批綁定」改由 TR 的 backend 測試，以及 T9 經 BFF 與真實 Agent Server 的 smoke 證明。BFF 傳輸證明失敗，或需要 §6.13 以外的 bff 正式程式碼修改時，即停止並退回 PLAN_DRAFT 補 BFF delta，不得直接修改。
- 限流、每日成本上限與 demo access code 屬 v7 D4 Lane C／D5，不在本 Change（§13 Q1）。

## 13. 規劃預設決策（Human 可於 review-plan 推翻）

| # | 疑問 | 預設決策 | 理由 |
|---|---|---|---|
| Q1 | BFF 限流／成本上限／access code 是否屬 X43 | **不屬於**；另開部署護欄 Change，於 D5 前完成 | v6／v7 X43 acceptance 未列；屬 BFF 與部署責任；避免 X43 跨三套件擴大 |
| Q2 | ledger 唯一鍵含 scope，去重涵蓋範圍 | 現有證據顯示 active scope 為 tenant 層級；key 含申請者 principal（§6.3），因此去重涵蓋**同一使用者**在同一 tenant 的不同 thread；D4 並行測試以同一使用者的兩個 thread 進行。模擬 provider 的 `ORDER_OPERATION_ALREADY_EXISTS` 保留為業務規則防線，只在 T0 發現 scope 比 tenant 細時才有對應的驗收情境。T0 確認實際 scope 粒度；若不是 tenant 層級，回報 CCR 重新評估 | 不修改既有 ledger 唯一鍵語意；D4 測試要對應使用者實際能觸發的重複路徑 |
| Q3 | 模擬 provider 是否持久化 | **in-memory** + 合成 fixture + 故障注入 | 模擬外部系統；不新增 store；重啟後無法判定即維持 `outcome_unknown`（誠實） |
| Q4 | 一句話同時含多個意圖 | 路由為 `clarify`，請使用者分開 | v1 單意圖；多意圖編排不在鏈路必要範圍 |
| Q5 | 審批人 | demo 中由同一使用者在介面審批；審批身分取自 trusted context | 符合 durable HITL；營運審批角色屬後續 |
| Q6 | 審批逾時長度 | 版本化設定（預設 15 分鐘），評測與測試以短逾時設定驗證 | 不寫死；可重現 |
| Q7 | 生成模型 | 鏈路使用單一 tier，記錄於 provenance；tier 對比屬 X48 | v7 Model choices |
| Q8 | S2 修正方向 | **Master 決策：做法 A**（明確的已釋放狀態，§6.8；第 7 版起以 `released_at` 欄位表達，§6.11） | 狀態寫在資料裡、可稽核，判斷集中一處；替代方案見 §15 |
| Q10 | S7 去重的表達方式 | **Master 決策：方向 B**，harness 契約新增 `deduplicated` 類型（§6.12）；harness 直接修改、不另開 change；不要求舊版 runtime 解析新類型（無對外服務）；既有 graph 以 opt-in 與 legacy 映射保持行為不變 | 去重是 dispatch 層的通用事實，之後的 side-effect tool 都會用到；放在 outcome 才不會出現「結果說成功、真相在 ledger」的兩個事實來源 |
| Q11 | SI-5（客戶端可寫入 graph state）是否納入 X43 | **Master 決策：納入**，BFF 阻擋 state 寫入與 `command.update`／`goto`（§6.13）；另依 Master 指示「確保客戶端不會再有機會偽造 decisionId」，decisionId 以型別參數傳遞並以 server 端紀錄驗證（§6.10） | X43 的訂單操作依賴 state 中的審批資料；不關閉寫入路徑，人工審批可被繞過 |
| Q12 | S9：審批 resume 的 run 綁定如何修正、是否涵蓋 `mcp_agent` | **Master 決策：方向 A**，以伺服器端記錄的等待中 run 與同一 thread 綁定，承載 resume 的 run 不參與比對（§6.14）；**`mcp_agent` 直接納入**修正範圍 | 與澄清 resume 以伺服器端權威 correlation 綁定一致；不需強制啟用 governance；修改位於共用授權節點，另做 opt-in 只會讓 `mcp_agent` 維持已知缺陷 |
| Q9 | 審批前預檢（資格、擁有者、provider 可用性）是否放進 X43 | **不放進 X43**（CCR 依 Master 授權決定），記入 Retrofit Debt | 正確性由 §6.8 保證，預檢只改善體驗；需要新的唯讀 governed tool，會擴大 X43 範圍；「核准後才得知不符資格」是誠實狀態 |

## 14. Retrofit Debt（本 Change 新增或承接）

| Debt | Closed by |
|---|---|
| 操作歷史無使用者可見 projection，只有目前狀態 | X30 |
| 無補償契約；`outcome_unknown` 只建立 task，無 worker | X31 |
| 建於 pre-X28 boundary | X28-min |
| Fast Lane tool 未通過 conformance suite | X29 |
| 營運 runbook、正式 store migration 計畫 | X29、X41 |
| 模擬 provider 為 in-memory，多 instance 不一致 | X40（真實 provider 選型） |
| 評測為離線回歸，無 shadow／A-B | X35 |
| 審批前不預先提示「已有相同操作」（去重於審批後的 dispatch 才判定） | X30 |
| 審批逾期沒有背景掃描；resume 與撤回時寫入，狀態查詢時只計算不寫入 | X30 |
| 審批前沒有預檢（Q9）：非擁有者、不符資格或 provider 不可用的申請，都要先經過審批才得到 typed failure | X30 |
| 撤回失敗後只支援重試取消，原審批的核准路徑不再可用（§6.2 步驟 5，fail-closed） | X30 |
| BFF 的客戶端 state 寫入檢查依 LangGraph API 1.4.5 的路由與欄位；升級 LangGraph API 時須重新核對（§6.13） | 升級 LangGraph API 的 Change |
| 既有 graph（`mcp_agent` 等）未宣告輸入 schema，內部 channel 仍可經 run 輸入賦值；目前由 gate 重新授權，風險有限 | 另開 Change |
| 審批的等待中 run 與承載 resume 的 run 只在 audit 連結，canonical correlation 沒有正式的「resume run」關係欄位（§6.14） | X30 或 canonical-execution-context 的後續 Change |
| Dockerfile 的 graph 清單與 http 設定和 `langgraph.json` 各寫一次，新增 graph 時容易漏改（§6.15 第 7 點） | 改由 `langgraph.json` 產生部署設定的後續 Change |
| `math_agent` 在 dispatch pipeline 開啟時同樣以 `readExecutionContext` 建立 context，推測經 Agent Server 時也缺 taskId，未以 live 請求驗證（§6.15） | 另開 Change |
| 整合測試曾預先插入 `agent_tasks`／`task_steps`，或在 context 直接帶入 `taskId`／`stepId`，掩蓋入口未登記 task（S10）與 dispatch 缺 `stepId`（S11）的問題；其他 graph 的整合測試未逐一檢查 | 另開 Change |
| 審批紀錄與 manifest 的 `step_id` 為 null，審批與 dispatch step 只經 `decisionId`／`toolCallId` 連結，沒有直接的 step 關聯（§6.16 第 3 點） | X30 或 canonical-execution-context 的後續 Change |
| X42 Minor：knowledge migration runner 未以交易包住單一 migration | 若本 Change 新增 knowledge migration 則於 T1 先修；預設設計不新增，維持承接 |

## 15. 替代方案

| 方案 | 不採用原因 |
|---|---|
| 擴充 `mcp_agent` 承擔購物情境 | 通用 tool loop 無法結構化強制拒答與單意圖路由；訂單 tool 會暴露給 MCP 情境 |
| 新建第二套 ledger 或審批儲存 | 違反單一事實來源；既有 X20／side-effect 基礎設施已涵蓋 |
| 以 toolCallId 或 runId 當冪等鍵 | 同一邏輯退款在不同 tool call 會重複執行（Invariant 6） |
| 以關鍵字或 regex 路由 | 違反禁止硬編碼；誤分流不可觀察 |
| 審批後失敗自動重試 | 可能重複副作用；違反「未知結果不盲目重試」 |
| 新增 `reconciliation.*` runtime event type | 需修改 `runtime-event-contract` 與三套件；card 欄位與 audit 已足夠 |
| 模擬 provider 用 Postgres | 增加 store 與 migration；模擬外部系統不需要 |
| 提供「取消已確認退款」按鈕 | 等同未經驗證的補償（Invariant 8，X31） |
| S6：在既有 CHECK 加入新狀態值（`withdrawn`、`released`、未取得 claim 的執行狀態） | 需 `DROP CONSTRAINT`，違反 additive migration gate；舊版 instance 讀到未知值會 throw，違反 mixed-version 並存 |
| S6：撤回另建獨立的撤回紀錄表 | 可行但多一張表與一次 join；nullable 欄位已足以區分，且與既有 additive 模式一致 |
| S5：在 interaction runtime「沒有東西可取消」分支加撤回 hook | 只在 governance 啟用時有效（預設未啟用），仍需方向 1；graph 未執行就沒有狀態 card，前端只能從 runtime 事件推斷 |
| S5：新增專用撤回 API | 需要新 BFF 路由，X43 會多出 bff 正式程式碼變更 |
| S5：先撤回、再以既有 cancellation 治理取代 run（第 5 版） | 等待審批時沒有 run 可以取代；production 也未注入 `decideCancellation` |
| 在 harness resume schema 加入 `cancel` 決定 | 撤回與拒絕是不同行為者的不同動作；需要 harness 契約 major 變更並影響所有 consumer |
| 前端依期限自行顯示 `approval_expired` | UI 推測後端語意；與 server 狀態可能不一致 |
| 以 businessEffectId 作為操作識別 | 審批前不存在，審批前的狀態無法查詢 |
| 新增操作對照表 | 接近 X30 projection 的範圍；既有 decisionId 連結已足夠 |
| tool output 直接帶操作識別與狀態 | tool 不知道 approvalId 與去重結果；重用時會回傳原操作的識別 |
| 關閉訂單分支的平行 tool call | 依模型能力而定，換模型就可能失效；以 toolCallId 為鍵的 map 對任何數量都成立 |
| 狀態查詢時寫入逾期 | 唯讀 tool 不得寫入；計算結果與之後的 `consume` 判定一致 |
| 在預檢節點直接呼叫模擬訂單系統確認擁有者 | graph 節點直接呼叫外部系統，繞過 X14 dispatch（Invariant 1）；改以 key 含申請者防止洩漏 |
| key 不含申請者、只靠 tool 內的擁有者檢查 | 去重在 tool 執行前發生，擁有者檢查會被跳過，造成跨使用者洩漏 |
| S2：未提交時刪除或重設 business effect | 失去稽核紀錄，違反「每個效果都有 ledger 紀錄」；刪除與並行占用之間有競態 |
| S2：key 加入 approvalId 或嘗試序號 | 兩次各自審批的並行提交 key 不同，兩筆都會執行，破壞 D4 |
| S2：依最後一筆執行紀錄推導是否已釋放（不加新狀態） | 「已釋放」成為隱含狀態，每個讀取 `commit_state` 的元件都要重複推導，容易不一致 |
| S2：以 `expires_at` 當租約自動過期 | 執行時間較長的真實操作可能在租約過期後被重新占用而重複提交；沒有 fencing token 就不安全 |
| S8：BFF 改為路由 allowlist（只放行前端用到的端點） | 防禦較強，但會擋掉 LangGraph SDK 的其他讀取功能，且需完整盤點 SDK 行為；寫入面只有固定幾個入口，以拒絕清單加 graph 輸入 schema 已足夠 |
| S8：只在 backend 驗證（例如 dispatch 檢查 `activeToolCall` 是否由 gate 在本 run 寫入） | 需要在 state 中保存可信標記，而 state 本身就可被寫入；邊界問題應在邊界解決 |
| S8：審批綁定請求內容雜湊 | 可防輸入被換，但需新增 additive 欄位與所有審批路徑配合；關閉寫入路徑後不再必要 |
| §6.10：decisionId 經 execution config 傳遞（第 8 版原文） | 客戶端可在 run config 帶入，BFF 只以黑名單擋已知欄位 |
| S7 方向 A：envelope 維持既有值，graph 在 dispatch 後讀 ledger 判定去重 | outcome 與 ledger 成為兩個事實來源；circuit、audit、評測看到的分類不準；每個新的 side-effect graph 都要重做同樣的補查 |
| S7 方向 C：把去重資訊放進 `succeeded.result` | 進行中重複不是成功；既有消費者會把重複當成成功結果 |
| S7：為去重另加 flag，等所有 instance 升級後才發出 | 目前沒有對外服務與其他採用者，Master 決定不需要（§6.12） |
| S9 方向 B：`shopping_assistant` 一律啟用 interaction governance，以 active ownership 延續原 run | 需強制啟用目前預設關閉的 governance；`production.ts` 的 orchestrator 尚未在 governance 啟用環境實跑（§19 SI-2）；`mcp_agent` 也要一併改變部署設定 |
| S9：讓客戶端在 resume 時指定 run 識別 | Agent Server 一律覆寫 `run_id`，客戶端無法指定；即使可行，客戶端提供的識別也不得作為授權依據 |
| S9：只為 `shopping_assistant` 開 opt-in，`mcp_agent` 維持現狀 | 修改位於共用授權節點；opt-in 只會讓 `mcp_agent` 保留已知缺陷，Master 決定直接納入 |
| S9：新增 additive 欄位記錄承載 resume 的 run | audit 已能連結兩個 run；新增欄位需要 migration，沒有讀取方 |
| S2：交給訂單系統自行去重 | 把冪等責任推給外部系統；真實 provider 不一定支援（X40），違反 runtime 負責「冪等在效果之前」 |

## 16. 安全分析（Tool 變更）

| 面向 | 設計 |
|---|---|
| 身分 | tenant、scope、principal 只來自 server 端 execution context；input schema strict，夾帶身分或審批欄位即 schema error |
| 授權 | 每個 tool 明示 authorization action；未授權 typed deny，不呼叫 provider |
| 審批 | durable、一次性、綁定 approvalId／decisionId、伺服器端記錄的等待中 run 與同一 thread（§6.14）；承載 resume 的 run 與客戶端 run 識別不作為依據；模型與檢索內容無法記錄審批 |
| 冪等 | 邏輯 business effect key（含申請者 principal，避免去重跨使用者洩漏）；ledger fail-closed；審批後 `maxAttempts = 1` |
| egress | 訂單 tool 無外連；`kb_search` 沿用 X42 |
| 憑證 | 訂單 tool 不需要憑證；不讀取 `process.env` |
| prompt injection | chunk、訂單 note、使用者文字皆為資料；對抗案例驗證不觸發未請求的 tool、不跳過審批 |
| tool 授予 | 只透過 `shopping_assistant` agent manifest；其他 graph 無訂單 tool |
| 執行隔離 | `trusted_in_process`；不宣稱 OS 隔離（v7 第 11 條） |
| 對外描述 | mock tool、合成資料、無 OS sandbox、無 X41 gate（v7 External Description Boundary） |

## 17. 觀測性

- trace：路由結果（intent、rationaleCode、routeStatus）、tool dispatch 證據、審批 decisionId、business effect id、去重原因、reconciliation task id。
- metric：不得以 operationId 等高基數識別作 label（既有 Requirement）。
- audit：審批（含等待中 run 與承載 resume 的 run，§6.14）、提交、去重、未知結果、task 建立。
- 評測：意圖路由準確率與混淆矩陣、操作 terminal 狀態正確率、引用與拒答指標（沿用 X42）。

## 18. 驗證 Gate 對應

| Gate | 證據 | Task |
|---|---|---|
| D3 | 同一 session「商品查詢 → 政策問答」live smoke：政策引用可解析且只來自本輪 | T4、T5 |
| D4 | 並行重複提交 ledger 整合測試（真實 Postgres），一次提交、第二次 `deduplicated`；Human 確認為並行 | T7 |
| Chain 狀態列 | 前端測試涵蓋全部狀態與無 undo | T10 |
| 評測 | 約 15 題鏈路案例結果，deterministic 與 live 分開 | TB1、T11 |
| X42 Minor | knowledge migration 交易化（條件觸發） | T12 |

## 19. 順手問題（Side Issues）

在本 Change 規劃或盤點時順帶發現、不屬於 X43 主線但後續會用到的問題。每項記錄來源、目前判斷與處理位置；狀態更新時在此修訂。

### SI-1 side-effect ledger 的加鎖順序不一致

- **來源**：2026-10-24 CCR 討論 S2 時閱讀程式碼（推論，尚未以測試驗證）。
- **觀察**：
  - `prepare`：先鎖 `business_effects`（`INSERT ... ON CONFLICT DO NOTHING`，必要時 `SELECT ... FOR UPDATE`），再寫 `tool_executions`。
  - `commitExecutionAndBusinessEffect`：同一交易內先更新 `tool_executions`，再更新 `business_effects`。
  - 位置：`backend/src/runtime/side-effect/business-effect-ledger.ts` 的 `prepare` 與 `commitExecutionAndBusinessEffect`。
- **目前判斷**：重複提交在 `prepare` 時寫的是另一列 `tool_executions`，不會碰到持有者那一列，依現行寫法應不會形成循環等待；但兩邊加鎖順序相反，是典型的死鎖溫床。若之後的修改讓兩邊碰到同一列，Postgres 會偵測到死鎖並中止其中一個交易，表現為 `SIDE_EFFECT_LEDGER_UNAVAILABLE` 或 `SIDE_EFFECT_PERSISTENCE_UNCERTAIN`。
- **與 X43 的關係**：§6.8 的釋放與重新占用會讓三條路徑都同時寫兩張表，因此在 X43 內以 §6.9「加鎖順序一致」處理，並由 T2 以並行測試驗證。
- **後續**：若 T2 驗證時發現既有路徑已可重現死鎖，另行記錄並評估是否需獨立修正；本項維持開放，直到 T2 的並行測試結果寫入 evidence。
- **補充（第 5 版 T0）**：runner 的 `markUnknown` 以兩次獨立的 autocommit 更新先改 `tool_executions`、再改 `business_effects`，不具原子性；X43 依 §6.9 一併改為單一交易、先 `business_effects`。
- **T2a 結果（第 9 版記錄）**：提交、釋放、重新占用、`markUnknown` 與 reconcile 重試轉移皆改為單一交易、先 `business_effects`。真實 Postgres 上三者並行 20 輪、共 6 次執行（另 T2b 重跑 3 次）未發生死鎖，`pg_stat_database.deadlocks` 為 0（`evidence/t2a-summary.md`、`t2b-summary.md`）。修改前的程式未做死鎖重現測試，原推論未經實證。本項關閉。

### SI-2 production 的 interaction governance 未完整接線

- **來源**：2026-10-24 CCR 於 T1 開工核對（S5）。
- **觀察**：
  - `createProductionInteractionOrchestrator` 只有在設定 `INTERACTION_POLICY` 時才啟用；`.env.example` 預設為空，因此 production 預設**沒有** interaction governance。
  - 即使啟用，production 也沒有注入 `decideCancellation`；任何取代型策略（interrupt／supersede／rollback）遇到 active run 都會丟出 `InteractionRuntimeConfigurationError("Superseding interaction strategies require cancellation governance")`。
  - 位置：`backend/src/platform/interaction-runtime.ts` 207–243、880–884。
- **與 X43 的關係**：X43 不依賴取代型策略（§6.2 改在 graph 內撤回），只為 `shopping_assistant` 加一條 opt-in 轉送規則；不修補 production 的 cancellation 接線。
- **後續**：屬於 interaction runtime 自身的接線缺口，影響所有 graph 的取消與搶占行為；建議另開 Change 處理。本項維持開放。

### SI-3 審批被拒或逾期時，step 被寫成契約外的 `cancelled`

- **來源**：2026-10-24 CCR 於第 6 版 T1 開工、掃描 schema 與狀態機時發現（既有缺陷）。
- **觀察**：`backend/src/runtime/authorization/confirmation.ts` 在審批被拒（273–325）與逾期（223–265）時，把 `task_steps.status` 寫成 `cancelled`；但 harness 契約 `STEP_STATUSES`（`@gun-ai/harness-contracts` 的 `lifecycle.ts`）沒有 `cancelled`，`STEP_TRANSITIONS` 也不允許 `waiting_confirmation → cancelled`。`task_steps.status` 沒有 CHECK，所以資料庫不會擋。
- **與 X43 的關係**：X43 的撤回沿用既有 deny 的 task／step 轉移，不擴大也不修正這個缺陷；修正需要決定 step 該用哪個既有狀態，會影響 `mcp_agent` 等既有 graph。
- **後續**：建議另開 Change，於 harness 契約或 confirmation 儲存擇一修正並補測試。本項維持開放。

### SI-4 harness 的 governed outcome 有三份平行定義，且已不一致

- **來源**：2026-10-24 CCR 於第 8 版規劃 S7 時閱讀 harness 原始碼（唯讀）。
- **觀察**：
  - 同一組結果類型定義了三次：`tool.ts` 的 zod `governedToolOutcomeSchema` 與 TS 型別 `GovernedOutcome`，以及 `side-effect.ts` 的 `GovernedToolOutcome`。
  - 已有不一致：兩個 TS 型別的 `failed_not_committed` 有 `retryAfterMs?`，但 zod schema 是 strict 且沒有這個欄位，帶 `retryAfterMs` 的結果在 envelope 驗證時會被拒絕。
- **與 X43 的關係**：§6.12 新增類型時三處必須同步；TH 以測試確認三處對 `deduplicated` 一致。是否順便修正 `retryAfterMs` 或改為單一來源，由 Master 在 TH 決定；不修正也不影響 X43。
- **後續**：建議 harness 以 zod schema 為單一來源，用 `z.infer` 推導 TS 型別。本項維持開放。

### SI-5 客戶端可經 BFF 寫入 graph state（第 9 版納入 X43）

- **來源**：2026-10-24 CCR 依 Master 指示「確保客戶端不會再有機會偽造 decisionId」檢查 decisionId 的來源時發現。
- **觀察與影響**：見 §2 S8 與 `evidence/t0-inventory.md` §13。
- **處理**：Master 決定納入 X43，以 §6.13 與 `client-graph-state-boundary` delta 處理；既有 graph 的輸入 schema 記入 §14。
