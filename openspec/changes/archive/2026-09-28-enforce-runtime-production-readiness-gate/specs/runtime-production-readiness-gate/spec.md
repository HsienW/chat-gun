# runtime-production-readiness-gate Specification

## Purpose

定義端到端 Runtime production readiness gate 契約：以真實 execution composition root 為對象的 live canary、每個 durable Run/Task 的 `ExecutionManifest` 強制、以 canonical `runId` 關聯的 SLI 指標匯出與結果分離、version-pinned fault-injection 資料集與 release gate、禁止 bypass 的 architecture checks、每個 integration boundary 的回滾/停用開關，以及以 canonical correlation schema 的 operations runbooks 與 incident queries。目標是證明整合後 runtime 路徑（而非隔離原語）滿足安全、恢復、可觀測、效能與相容性要求，且 gate 會在 deliberate 回歸時正確 fail。

## ADDED Requirements

### Requirement: 建立單一 execution composition root

Backend MUST 建立單一 `ExecutionCompositionRoot`，以固定順序組裝 X12 canonical context → X17 normalized input → X18 governed context → X14 unified dispatch → X19 versioned event → X20 recovery，輸出 frontend-consumable output 與 evidence（audit／OTel／no-duplicate／runId 可查）。canary 與 production path MUST 共用此單一入口；MUST NOT 每個 Agent 各自複製 dispatcher 或 context 組裝路徑。

#### Scenario: 固定組裝順序

GIVEN 一個 `CanonicalExecutionRequest`（trusted principal + normalized input + `ExecutionManifest`）
WHEN 執行 `ExecutionCompositionRoot`
THEN MUST 依 X12 → X17 → X18 → X14 → X19 → X20 固定順序組裝
AND MUST 輸出 frontend-consumable output 與 evidence

#### Scenario: 單一入口不 per-Agent 複製

GIVEN production Agent 需要執行 Tool 與 model 呼叫
WHEN 檢查其執行路徑
THEN MUST 經單一 `ExecutionCompositionRoot`
AND MUST NOT 各自複製 dispatcher 或 context 組裝路徑

#### Scenario: 缺 mandatory 依賴 fail-closed

GIVEN `ExecutionCompositionRoot` 的任一 mandatory 依賴（X12/X14/X19/X20）不可用
WHEN 建立或執行
THEN MUST fail-closed
AND MUST NOT 以空值或旁路組裝

---

### Requirement: live canary 以真實 execution composition root 執行

Backend MUST 以 safe test resource 呼叫真實 execution composition root，走完 input → BFF → Graph → model/mock → Tool → persistence → event → frontend-consumable output 的完整路徑。canary MUST 使用 read-only／`memory_only` effect 與獨立 `canaryId`/nonce，MUST NOT 觸發外部 mutation 或污染 production path。

#### Scenario: canary 走完整 composition root

GIVEN 一個 safe test resource 與獨立 `canaryId`
WHEN 執行 live canary
THEN MUST 依序經 canonical `ExecutionContext`（X12）→ normalized input（X17）→ governed context（X18）→ unified Tool dispatch（X14）→ versioned event（X19）→ recovery（X20）
AND MUST 產生 frontend-consumable output

#### Scenario: canary 驗證 audit、trace 與無重複 effect

GIVEN canary 已走完 composition root
WHEN 執行 verify
THEN MUST 驗證 audit 存在、OTel trace 存在、`duplicateEffectCount === 0`
AND 四類結果 metric MUST 可依 canonical `runId` 查得
AND terminal output MUST 可被 frontend envelope 解析

#### Scenario: canary 不觸發外部 mutation

GIVEN 一個 live canary 執行中
WHEN 檢查其 side effect
THEN MUST 僅使用 read-only 或 `memory_only` effect
AND MUST NOT 對外部系統造成 mutation
AND MUST 留下 cleanup trace

#### Scenario: canary 失敗標記 deployment unhealthy

GIVEN canary 任一 verify 失敗
WHEN 執行 readiness gate
THEN MUST 標記 deployment unhealthy
AND MUST 記錄 `ExecutionManifest` 與 `runtimeBuildId`

---

### Requirement: 每個 durable Run/Task 具備 ExecutionManifest

每個 durable Run/Task 建立時 MUST 附 `ExecutionManifest`；缺漏 MUST fail-closed（不 dispatch、`invalid_policy`）。legacy Run 補齊 MUST 採 additive migration；資料不足 MUST 標記 `incompatible` 並 park，MUST NOT 以空值或推導值 resume。resume 相容性 MUST 以 manifest 為權威（compatible／migratable／incompatible）。

#### Scenario: 缺 manifest 時 fail-closed

GIVEN 一個 durable Run/Task 建立時無 `ExecutionManifest`
WHEN 建立或 dispatch
THEN MUST fail-closed 回 `invalid_policy`
AND MUST NOT dispatch 或推進 Graph

#### Scenario: legacy Run 資料不足時 park

GIVEN 一個 legacy Run 缺少 manifest 且無法自可信 ledger 重建
WHEN 執行 resume
THEN MUST 標記 `incompatible` 並 park
AND MUST NOT 以空值 resume

#### Scenario: resume 相容性以 manifest 為權威

GIVEN 一個 durable Run 附 `ExecutionManifest`
WHEN 判斷 resume 相容性
THEN MUST 依 compatible／migratable／incompatible 三態政策
AND `incompatible` MUST migrate、pin 或 park，MUST NOT blind replay

---

### Requirement: 以 canonical runId 關聯 SLI 指標

Backend MUST 以 X12 canonical `runId` 為查詢鍵關聯 Run、Task、Step、model、Tool、permission、reconciliation、compensation、context、stream 與 cost 指標。`runId` MUST 進 redacted 查詢索引，MUST NOT 成為 exposition 的 high-cardinality label；exposition 只含 low-cardinality 彙總 label。

#### Scenario: 依 runId 追一個 Run 的完整鏈

GIVEN 一個 Run 自 BFF 進入至 terminal
WHEN 以 canonical `runId` 查詢 SLI
THEN MUST 可沿 Run/Task/Step/model/Tool/permission/reconciliation/compensation/context/stream/cost 一次定位
AND `threadId`/`taskId`/`stepId`/`toolCallId` MUST 為次級投影

#### Scenario: exposition 不含高基數 runId label

GIVEN metrics exposition 輸出
WHEN 檢查 label
THEN MUST 只含 low-cardinality 彙總 label
AND MUST NOT 以 `runId` 或其他高基數/敏感值作為 label

---

### Requirement: 執行結果指標四類分離

Backend MUST 分離四類執行結果指標：`success`、`recovered_attempt_error`（嘗試失敗但已由 retry/resume/reconcile 恢復）、`terminal_failure`（未恢復的 failed/cancelled/timed_out/crashed）、`user_visible_failure`（有結構化 user-visible 錯誤/降級輸出）。四類結果 MUST 以新增獨立 metric family 表示，MUST NOT 改變既有 X10.2 metric 語意。

#### Scenario: 已恢復嘗試計入 recovered_attempt_error

GIVEN 一次 Tool/model 嘗試失敗後由 retry 或 resume 恢復且 Run 成功
WHEN 計量執行結果
THEN MUST 計入 `recovered_attempt_error`
AND MUST NOT 計入 `terminal_failure`

#### Scenario: 未恢復失敗計入 terminal_failure

GIVEN 一次執行未恢復且 terminal 為 failed/cancelled/timed_out/crashed
WHEN 計量執行結果
THEN MUST 計入 `terminal_failure`
AND MUST NOT 計入 `success`

#### Scenario: 結構化降級計入 user_visible_failure

GIVEN 一次執行有結構化 user-visible 錯誤/降級輸出
WHEN 計量執行結果
THEN MUST 計入 `user_visible_failure`
AND MUST 與 `terminal_failure` 可分離

#### Scenario: 四類分離不改變既有 metric 語意

GIVEN X10.2 既有 metric family
WHEN 新增四類結果 metric
THEN MUST 以新增獨立 family 表示
AND MUST NOT 改變既有 metric 的語意或值

---

### Requirement: version-pinned fault-injection 與 release gate 負向檢查

Release gate MUST 以 version-pinned fault-injection dataset（`datasetId` + `datasetVersion`）執行 negative checks。fault 全為 in-process／memory_only fixture，MUST NOT 觸發外部 mutation。deliberate 的 decoder、authorization、side-effect duplicate、recovery、context overflow、event terminal-monotonicity 回歸 MUST 使 release gate `failed`；若 gate 於 fault 下仍 `passed`，MUST 視為 gate 失效。

#### Scenario: deliberate decoder 回歸使 gate fail

GIVEN 一筆 version-pinned fault 使 Tool argument 解碼產生 `invalid`/`incomplete`
WHEN 執行 release gate
THEN MUST 回 `failed`
AND MUST NOT 回 `passed`

#### Scenario: deliberate side-effect duplicate 回歸使 gate fail

GIVEN 一筆 fault 使同 business-effect key 重複 commit
WHEN 執行 release gate
THEN MUST 回 `failed`

#### Scenario: 正常 fixture 不誤 fail

GIVEN 一筆合法 fixture（無回歸）
WHEN 執行 release gate
THEN MUST 不因 fault-injection 而誤 fail

#### Scenario: gate 於 fault 下仍 passed 視為失效

GIVEN deliberate fault 已注入
AND release gate 回 `passed`
WHEN 判定 negative check
THEN MUST 將 gate 標記為失效
AND MUST NOT 以 unversioned LLM-judge 作為唯一 release 訊號

---

### Requirement: architecture checks 禁止六類 bypass

Backend MUST 以 runtime fail-closed 與靜態 archguard test 禁止六類 bypass：直接呼叫受保護 Tool、mutation Tool 無 `side-effect` descriptor、production registry 無 authorization、未版本化 runtime event producer、Agent 使用 legacy context assembly、trusted identity 取自 client-controlled metadata。architecture checks MUST 只偵測 bypass，MUST NOT 重寫既有 dispatcher/authorization/context/event 契約。

#### Scenario: mutation Tool 無 side-effect descriptor 註冊失敗

GIVEN 一個 mutation Tool 無 `side-effect` descriptor
WHEN 於 production registry 註冊
THEN MUST 註冊失敗
AND MUST NOT 進入 dispatch

#### Scenario: production registry 無 authorization 初始化失敗

GIVEN production Tool registry 未注入 authorization 組合
WHEN 初始化 composition root
THEN MUST 初始化失敗
AND MUST NOT 以未授權 registry dispatch

#### Scenario: dispatch 無 canonical context 拒絕

GIVEN dispatch 缺 canonical `ExecutionContext`
WHEN 派發 Tool
THEN MUST 拒絕
AND MUST NOT 執行 Tool

#### Scenario: 靜態 archguard 偵測六類 bypass

GIVEN production Agent／registry／event producer／identity 來源
WHEN 執行靜態 archguard test
THEN 直接呼叫受保護 Tool、mutation 無 descriptor、registry 無 authorization、未版本化 event producer、Agent legacy context assembly、trusted identity 取自 client metadata MUST 使 test 失敗
AND 正常 production code MUST 不誤擋

---

### Requirement: 每個 integration boundary 的回滾/停用開關

每個 integration boundary（X12/X13/X14/X15/X16/X17/X18/X19/X20）MUST 有 `runtime-config` feature flag。停用 MUST 回退至已明確定義的安全前一行為，MUST NOT revert 資料庫歷史；authorization 類 boundary 停用 MUST default-deny，MUST NOT 退成 anonymous allow。每個非 auth boundary 的停用後行為 MUST 有明確定義（見 design §8 表）。

#### Scenario: 停用回退安全前一行為

GIVEN 一個 integration boundary 的 feature flag 設為停用
WHEN 執行該 boundary
THEN MUST 回退至安全前一行為
AND MUST NOT revert 資料庫歷史

#### Scenario: auth 類停用仍 default-deny

GIVEN authorization boundary 停用
WHEN 派發受保護 Tool
THEN MUST default-deny
AND MUST NOT 退成 anonymous allow

#### Scenario: mutation 安全不隨 flag 停用

GIVEN X14 unified dispatch 的 feature flag 設為停用
WHEN 派發 mutation Tool
THEN MUST 仍經 side-effect ledger／reconciliation
AND MUST NOT 因 flag 停用而繞過 mutation 安全

#### Scenario: 非 auth boundary 停用有明確定義

GIVEN 任一非 auth boundary（X12/X14/X15/X16/X17/X18/X19/X20）停用
WHEN 檢查其停用後行為
THEN MUST 有明確定義的安全前一行為與連鎖影響
AND MUST NOT 退成未定義的放行

#### Scenario: 停用後狀態可收斂

GIVEN 一個 boundary 停用後
WHEN 檢查其狀態收斂語意
THEN MUST 有明確的停用後行為與狀態收斂語意
AND MUST 記錄 boundary、default、停用後行為

---

### Requirement: runbooks 與 incident queries 使用 canonical correlation

Operations runbook 與 incident queries MUST 以 X12 canonical correlation schema 更新，使 operator 能以 canonical `runId` 一次定位 event、audit、trace、ToolExecution 與 terminal result（唯讀投影，受 X13 auth 保護）。BFF MUST 提供唯讀 incident query route（`GET /api/incidents/:runId`）回結構化 JSON，MUST 與既有 metrics proxy（`GET /api/operations/metrics` 的 Prometheus/OpenMetrics 透傳）分離。

#### Scenario: 依 runId 一次定位完整紀錄

GIVEN 一個 incident 的 canonical `runId`
WHEN 執行 incident query（`GET /api/incidents/:runId`）
THEN MUST 一次定位 event、audit、trace、ToolExecution、terminal result
AND MUST 受 X13 auth 保護
AND MUST 回結構化 JSON，MUST NOT 以 metrics text 回覆

#### Scenario: incident query 與 metrics proxy 分離

GIVEN `GET /api/incidents/:runId` 與 `GET /api/operations/metrics`
WHEN 檢查兩者契約
THEN MUST 為不同 route
AND `GET /api/operations/metrics` MUST 維持既有 Prometheus/OpenMetrics 透傳語意不變

#### Scenario: parked/manual 狀態有 operator 動作

GIVEN 一個 parked/manual 狀態的 Run
WHEN 查詢 runbook
THEN MUST 描述 operator 的預期動作
AND MUST 依 canonical correlation 可查該狀態
