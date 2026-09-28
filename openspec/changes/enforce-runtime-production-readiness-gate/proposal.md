# Proposal: enforce-runtime-production-readiness-gate

## 問題

X10.2（runtime-operations-slo-eval-release-gate）已建立 canary、release gate、`ExecutionManifest`、metrics export 與 SLO/SLI；X11–X20 已建立 canonical `ExecutionContext`（X12）、trusted authorization（X13）、unified Tool dispatch（X14）、bounded decode（X15）、scheduling/resilience（X16）、normalized input（X17）、context budget/compression/memory（X18）、versioned runtime event（X19）與 durable recovery（X20）。但這些原語目前各自證明「單點」能力，尚無單一 gate 證明「整合後的 runtime 路徑」——`input → BFF → Graph → model/mock → Tool → persistence → event → frontend-consumable output`——整體滿足安全、恢復、可觀測、效能與相容性：

1. **canary 未走真實 composition root**：X10.2 canary 只以自身 safe-mock path 證明 `create → step → persist → safe tool → checkpoint → resume → verify`，未呼叫由 X12 canonical context、X14 unified dispatch、X18 governed context、X19 versioned events、X20 recovery 組成的真實執行 composition root，無法證明這些原語在實際 Graph/Tool 呼叫中已被啟用。
2. **`ExecutionManifest` 未強制於每個 durable Run/Task**：X10.2 定義 manifest type、X20 以 `ExecutionManifestRef` 做 resume 相容性，但無機制保證每個 durable Run/Task 都帶 manifest；缺 manifest 的 Run 仍可能繞過相容性政策。
3. **SLI 指標未以 canonical `runId` 關聯**：X10.2 匯出 Run/Task/Step/model/Tool/cost 指標，但未以 X12 `runId` 作為關聯鍵；correlation drift 使「沿 BFF 到 terminal 追一個 Run」不可查。
4. **結果指標未分離**：Run success、recovered attempt error、terminal failure、user-visible failure 未分開計量，無法區分「已恢復」與「真正失敗」，導致 SLO 失真。
5. **無 version-pinned fault-injection 證明 gate 會擋**：release gate 只有正向 checks，未以 deliberate decoder/authorization/side-effect/recovery/context/event 回歸證明 gate 會在回歸時 fail。
6. **無 architecture checks 禁止六類 bypass**：直接呼叫受保護 Tool、mutation Tool 缺 side-effect descriptor、production registry 缺 authorization、未版本化 event producer、Agent 用 legacy context assembly、trusted identity 取自 client metadata，皆無編譯/測試層面的架構防線。
7. **無逐 boundary 回滾/停用開關**：各 integration boundary 缺可獨立停用並回退至安全前一行為的 switch，且不 revert 資料庫歷史。
8. **runbooks/incident queries 未用 canonical correlation**：operations runbook 未以 X12 canonical correlation schema 更新查詢，operator 無法沿 `runId` 一次定位事件、audit、trace、ToolExecution 與 terminal result。

## 解決方案概述

不新增第二個 Run Runtime（Invariant #1）、不自建 metrics 聚合器、不新增 business adapter，以「composition + proof」為主軸建立單一端到端 production readiness gate：

1. **`ExecutionCompositionRoot`（核心交付）**：建立單一真實執行 composition root，以固定順序組裝 X12 canonical context → X17 normalized input → X18 governed context → X14 unified dispatch → X19 versioned event → X20 recovery；現有 canary 只透過 `CanaryDependencies` DI 抽象、未呼叫真實模組，本 change 補上可被 canary 與 production path 共用的單一執行入口。
2. **`ReadinessGate` composition root**：組合 X10.2 release gate、canary、architecture checks、fault-injection 為單一 gate 入口；任一項 fail → gate fail。
3. **canary 擴充**：以 safe test resource 呼叫 `ExecutionCompositionRoot`，證明整合原語在實際路徑中啟用。
4. **`ExecutionManifest` 強制**：每個 durable Run/Task 建立時必須附 `ExecutionManifest`；缺漏 fail-closed，resume 相容性判斷以 manifest 為權威；含 deployment hook + bounded timeline 的 additive migration。
5. **correlated SLI + 結果分離**：以 canonical `runId` 關聯指標，並分離 `success`／`recovered_attempt_error`／`terminal_failure`／`user_visible_failure`。
6. **version-pinned fault-injection datasets**：deliberate 六類回歸 dataset，證明 release gate 在回歸時 fail。
7. **architecture checks**：runtime fail-closed + 靜態 archguard test 禁止六類 bypass，並附 operator override（reason code + audit + TTL）。
8. **per-boundary rollback/disable switches**：每個 integration boundary 的 feature flag/config，停用即回退至明確定義的安全前一行為，不 revert DB 歷史。
9. **runbooks/incident queries**：以 canonical correlation 更新，並新增唯讀 `GET /api/incidents/:runId` 查詢。

## 受影響範圍

| 套件 | 能力域 | 影響 |
|---|---|---|
| backend | operations（canary、release-gate、metrics、manifest） | 擴充 `ReadinessGate`、fault-injection、architecture checks、correlated metrics、manifest 強制、rollback switch |
| backend | runtime composition root（X12/X14/X18/X19/X20） | 唯讀引用並以 canary 證明其啟用；不改其契約 |
| bff | metrics proxy／stream proxy | correlated metrics 關聯鍵透傳、incident query 契約承接（沿用 X13 auth、X19 透傳） |
| frontend | event envelope consumption | 僅以既有 X19 envelope 驗證，不新增 UI 行為 |
| docs | operations runbooks | 以 canonical correlation schema 更新 runbook 與 incident queries |

## 目標

- 證明整合後 runtime 路徑（非隔離原語）滿足安全、恢復、可觀測、效能、相容性。
- live canary 以真實 composition root 走完 input → Graph → Tool → persistence → event → frontend-consumable output。
- 每個 durable Run/Task 具備 `ExecutionManifest`；缺漏 fail-closed。
- SLI 指標以 canonical `runId` 關聯，並分離四類執行結果。
- version-pinned fault-injection 證明 release gate 在 deliberate 回歸時 fail。
- 六類 forbidden bypass 有 runtime 與靜態 architecture checks 防線。
- 每個 integration boundary 有可停用、不回退 DB 歷史的回滾開關。
- runbooks 與 incident queries 以 canonical correlation 更新。

## 非目標

- ❌ 不新增第二個 Run/queue/worker Runtime（Invariant #1）。
- ❌ 不自建 metrics 聚合器、TSDB 或 dashboard（走 X8/X10.2 OTel exporter 邊界）。
- ❌ 不在 business logic 寫死 production SLO 數字、threshold、URL、Port、credential。
- ❌ 不以 unversioned LLM-as-a-judge 作為唯一 release/completion 訊號。
- ❌ 不以 `/health = 200` 定義 deploy 成功。
- ❌ 不在本 gate 通過前重新引入 optional business adapter。
- ❌ 不修改 X10.2–X20 既有 module 契約；architecture checks 只「偵測 bypass」，不重寫既有 dispatcher/authorization/context/event。
- ❌ 不 revert 資料庫歷史作為回滾手段。

## 風險與回滾策略

| 風險 | 嚴重度 | 緩解 | 回滾 |
|---|---|---|---|
| canary 擴充誤把 production path 污染 | High | canary 只用 safe test resource、read-only/memory_only effect、獨立 cleanup trace | 停用 canary feature flag，回退 X10.2 safe-mock canary |
| `ExecutionManifest` 強制誤殺 legacy Run | High | 以 additive migration 補 manifest；資料不足時 `incompatible` + park，MUST NOT 以空值 resume | 停用 manifest 強制 flag，回退為 X10.2 既有 manifest 政策 |
| 指標關聯鍵引入高基數 label | Medium | 只以 low-cardinality 彙總 label 匯出；`runId` 進 redacted 查詢索引而非 exposition label | 停用 correlated label flag，回退 X10.2 彙總維度 |
| 結果分離造成既有 SLO 語意漂移 | Medium | 四類結果以新增獨立 metric family 表示，不改變既有 metric 語意 | 停用 separation flag，回退單一 success/failure 計量 |
| architecture checks false-positive 誤擋 | Medium | 靜態檢查採明確符號/pattern、附 reason code；runtime check fail-closed 於 composition root | 停用 archguard flag，附 operator 放行 path |
| fault-injection dataset 誤連真實外部效應 | High | dataset 全為 in-process/memory_only fixture，不觸發外部 mutation | 停用 fault-injection flag |
| rollback switch 停用後狀態不一致 | Medium | 每個 switch 定義「停用後的安全前一行為」與狀態收斂語意，不 revert DB 歷史 | 重新啟用即回退至整合路徑 |

## 相容性

- 既有 X10.2 metrics、canary、release gate、manifest 契約不變；X21 為 additive 擴充。
- 既有 Graph ID、公開 BFF route、error-code 語意不變。
- 既有 events 可於 bounded migration window 省略新關聯欄位；新 producer 發完整 canonical context（X12）。
- `ExecutionManifest` 強制以 additive migration 補齊；legacy Run 資料不足時 `incompatible` + park，MUST NOT blind replay。
- architecture checks 只新增偵測，不變更既有 module 的執行路徑。
