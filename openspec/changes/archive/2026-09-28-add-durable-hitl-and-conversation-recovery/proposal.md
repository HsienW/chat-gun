# Proposal: add-durable-hitl-and-conversation-recovery

## 問題

Chat-Gun 已在 X13（trusted-tool-authorization）建立 `require_confirmation` 的 durable confirmation bridge、在 X17（normalized-input-query-guard）建立 `clarification_resume` 的 interrupt 語意、在 X14（unified-tool-dispatch-pipeline）建立 mutation Tool 的 reconciliation 路徑、在 X19（runtime-event-contract）建立 `needs_user`／`manual_intervention_required` 的可復原 terminal 契約。但這些原語目前各自證明「單點」的等待/恢復能力，尚未組成一條跨 process failure 的單一 durable recovery 執行路徑：

1. **等待狀態的 durability 不完整且不統一**：X13 的 confirmation waiting state 已持久化（decision、correlation、expiry、scope），但 X17 的 `clarification_resume` 只以 `interruptId` 傳遞，缺少一份涵蓋「預期回應 schema、expiry、authorization scope、resume compatibility manifest」的統一 durable manifest。兩類 interrupt 無法以同一份權威等待記錄被 recovery 掃描與分類。
2. **Resume 前沒有 protocol-validity 消毒**：重啟後直接以持久化的 message/Tool 歷史續跑，未先偵測 unmatched Tool calls/results、incomplete Tool argument fragments、orphaned thinking/content blocks、partial assistant messages、invalid legacy enum/config values、already-terminal Tool results、incompatible execution manifests。一旦歷史含殘缺片段，直接 replay 會製造不合法的模型請求或重放不安全工作。
3. **沒有 last durable execution point 分類**：recovery 無法定義「上次可證明進度落在 not_started／executing／committed／unknown／terminal／waiting_user 的哪一點」，因此無法決定 resume、reconcile 或 park；committed/unknown mutation 也尚未強制經 X14 reconciliation 才可 continuation。
4. **取消原因與 transport disconnect 混為一談**：user cancel、timeout、crash、supersede、client disconnect 的語意未分離持久化，導致 recovery 無法正確分類。
5. **沒有 crash terminal policy**：process 於 fatal corruption 時未明確定義「停止 claims、flush bounded telemetry、persist crash/recovery state、exit non-zero」的處置。

這些缺口使得 approval、clarification、interruption、cancellation、resume 在 process failure 之後可能丟失等待語意、回放不安全工作、或恢復出 protocol-invalid 的對話歷史。

## 解決方案概述

在不引入第二個通用 Run Runtime（Invariant #1）的前提下，以 LangGraph native interrupt/checkpoint（X11）為權威，建立一條「durable interrupt manifest + recovery sanitizer + last-execution-point classifier + crash terminal policy」的單一 recovery 路徑：

1. **統一 `DurableInterruptManifest`**：為 confirmation 與 clarification 兩類 interrupt 建立單一權威等待記錄，持久化 `interruptId`、Run/Task/Step correlation、預期回應 schema reference、expiry、authorization scope、resume compatibility manifest 與 waiting 狀態。
2. **`RecoverySanitizer`**：在 resume 前對持久化對話/Tool 歷史執行 protocol-validity 消毒，回傳 typed `SanitizeResult`（`valid`／`sanitized`／`parked`）；無法證明有效時 park 並附 diagnostics，MUST NOT 自行發明 message。
3. **`LastExecutionPointClassifier`**：以持久化的 Task/Step/ledger/checkpoint 狀態分類 `not_started`／`executing`／`committed`／`unknown`／`terminal`／`waiting_user`；committed/unknown 的 mutation 一律先經 X14 `SideEffectReconciler` 才可 continuation。
4. **取消/終止原因分離持久化**：`cancellationReason` 與 `transportDisconnect` 分欄保存，recovery 依 stable reason code 分類。
5. **`CrashTerminalPolicy`**：fatal corruption 時停止新 claims、flush bounded telemetry、盡力持久化 crash/recovery state、exit non-zero；本地 redacted diagnostics 與外部 error export 配置分離。

## 受影響範圍

| 套件 | 能力域 | 影響 |
|---|---|---|
| backend | LangGraph Runtime／interrupt／checkpoint | 新增 durable manifest、sanitizer、classifier、crash policy，擴充 confirmation-graph 與 clarification resume 的 recovery 接線 |
| backend | Tool Execution（reconciliation） | 將 committed/unknown 分類接上 X14 reconciler |
| backend | Task/Step persistence | 新增 interrupt manifest 持久化與 waiting_user 分類 |
| bff | stream proxy | 透傳 interrupt/resume 事件，不語意改寫（沿用 X19 契約） |
| frontend | HITL/clarification UI | 承接 `needs_user`／`manual_intervention_required` 可復原狀態與 resume，不變更既有 UI 契約 |

## 目標

- 使 approval、clarification、interruption、cancellation、resume 跨 process failure 存活。
- Resume 只回到預期的 waiting Task，且回應最多消費一次。
- 恢復歷史經 sanitizer 驗證，protocol-invalid 歷史不直接 replay。
- committed/unknown mutation 經 reconciliation，不盲目重放。
- user cancel、timeout、crash、supersede、client disconnect 語意可分離。
- fatal corruption 有明確 crash terminal policy。

## 非目標

- ❌ 不建立第二個通用 Run/queue/worker Runtime。
- ❌ 不以 transcript 內容證明外部 side effect 已發生。
- ❌ 不為 unresolved Tool call 合成假的 success 結果。
- ❌ 不在 fatal corruption 後繼續 process。
- ❌ 不變更既有 Graph ID、公開 BFF route、error-code 語意。
- ❌ 不以自然語言關鍵字、Regex、顯示文案或模型輸出作為分類/sanitize 的機讀來源。

## 風險與回滾策略

| 風險 | 嚴重度 | 緩解 | 回滾 |
|---|---|---|---|
| durable manifest 被誤當成第二個 Run store | High | 明確以 LangGraph checkpoint 為權威，manifest 只補充等待/recovery 語意，不複製 native scheduling | 移除 manifest 表即可回退，checkpoint 不受影響 |
| sanitizer 誤殺合法歷史（false-positive park） | Medium | sanitizer 採結構/schema 偵測，回 `parked` 僅在無法證明有效性時；附 reason code 供 operator 放行 | feature flag 關閉 sanitizer，採 pass-through |
| classifier 誤判 committed/unknown 導致重放 | High | 以 ledger/checkpoint 持久化證據分類，unknown 一律 reconcile/park，不假設 committed | 關閉 continuation，回退為全量 park |
| 既有 confirmation/clarification 行為回歸 | Medium | 以 adapter 包既有模組，不重寫既有 dispatcher/authorization | 既有路徑不變，recovery 為 additive |
| live checkpoint 驗證受限（X11 已知限制） | Medium | 沿用 X11「未驗證即標記」原則，不以 langgraph dev 推論正式部署 | 相關 acceptance 標記「未驗證」而非假稱通過 |

## 相容性

- 既有 confirmation（X13）與 clarification（X17）interrupt 語意不變，新增 durable manifest 為 additive。
- 既有 events 可於 bounded migration window 省略新欄位；新 producer 發完整 manifest 欄位。
- 既有 Graph ID、公開 BFF route、error-code 語意不變。
- `needs_user`／`manual_intervention_required` 的可復原語意沿用 X19。
