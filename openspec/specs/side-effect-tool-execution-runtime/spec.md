# side-effect-tool-execution-runtime Specification

## Purpose

TBD - created by archiving change add-side-effect-tool-execution-runtime. Update Purpose after archive.

## Requirements

### Requirement: replayKey MUST 代表同一 logical Tool call，MUST NOT 包含會遞增的 attempt

`replayKey` MUST 由 `runId + stepId + logicalToolCallId/toolCallId + callIndex + toolName + toolVersion` 組成（經 hash），代表同一 logical Tool call，跨 checkpoint replay/resume 保持不變。`replayKey` MUST NOT 包含會遞增的 `attempt`。

#### Scenario: 同一 logical call 的 replay 產生相同 replayKey

GIVEN 一個 Agent Tool call 在 Graph/node 執行
AND 其 identity 由 `runId`、`stepId`、`logicalToolCallId`、`callIndex`、`toolName`、`toolVersion` 決定
WHEN Graph/node 因 checkpoint resume 而 replay 該 call
THEN 產生的 `replayKey` MUST 與首次執行相同
AND `replayKey` MUST NOT 因 resume 而改變

#### Scenario: 每次 physical 重試不改變 replayKey

GIVEN 一個 Tool call 因下游 timeout 需要重試
WHEN 進行 physical retry（下游實際呼叫第二次）
THEN `replayKey` MUST 保持不變
AND 重試次數 MUST 由獨立的 `toolExecutionAttemptId`／`executionAttempt` 記錄，而非改變 `replayKey`

#### Scenario: attempt 若保留必須為 logical call generation

GIVEN identity 中必須保留 `attempt` 欄位時
WHEN 定義其語意
THEN `attempt` MUST 定義為 logical call generation
AND checkpoint replay MUST NOT 遞增 `attempt`
AND 實際下游重試 MUST 使用獨立的 `executionAttempt`（physical attempt）

---

### Requirement: toolExecutionAttemptId MUST 代表每次 physical invocation 的唯一 ID

每次實際呼叫下游 MUST 建立唯一的 `toolExecutionAttemptId`，並以 `executionAttempt` 遞增，與 logical `replayKey` 分離。

#### Scenario: 同一 logical call 的多次 physical dispatch 有不同 attempt ID

GIVEN 一個 logical Tool call 因 retry 進行三次 physical dispatch
WHEN 每次 dispatch 建立 attempt 紀錄
THEN 每次 MUST 有唯一的 `toolExecutionAttemptId`
AND `executionAttempt` MUST 依序遞增（1、2、3）
AND 三個 attempt MUST 指向同一 `replayKey`

---

### Requirement: businessEffectKey MUST 跨 replay、attempt、後續 Run 保護同一業務效果

`businessEffectKey` MUST 由 `SideEffectToolDescriptor.deriveBusinessEffectKey(input, scope)` 產生，長效且預設 non-expiring，保護同一業務效果不因 replay 或 attempt 變動而重複執行。

#### Scenario: 不同 replayKey 但相同 committed businessEffectKey 不得重複執行副作用

GIVEN 一個 business effect 已 committed，其 `businessEffectKey` 為 `K`
AND 一個新的 logical call 因 Graph 重新產生而取得不同的 `replayKey`
AND 該 call 的 descriptor 對相同 input/scope 導出相同的 `businessEffectKey = K`
WHEN 嘗試 dispatch 該 side effect
THEN MUST 偵測到已 committed 的 business effect
AND MUST NOT 重複執行外部副作用

#### Scenario: business effect 的 tombstone 預設保留

GIVEN 一個 business effect 已 committed
WHEN 系統經過任意時間
THEN 其 tombstone MUST 預設保留
AND MUST NOT 因任意 purge 而重新開放副作用
AND 僅當 domain 明確存在有效期限時，才允許 business effect expiry

---

### Requirement: GovernedToolOutcome MUST 提供型別化的執行結果

`GovernanceExecutor.executeTyped()` MUST 回傳 discriminated union，區分 succeeded、rejected_before_dispatch、failed_not_committed、ambiguous_after_dispatch 與 cancelled（含 dispatchState）。外層 Runner MUST NOT 解析錯誤字串來分類結果。

#### Scenario: 下游成功回傳 succeeded

GIVEN 一個 Tool 被 dispatch 且下游成功回傳結果
WHEN 呼叫 `executeTyped()`
THEN 回傳 `{ type: "succeeded", result }`

#### Scenario: dispatch 前被拒絕回傳 rejected_before_dispatch

GIVEN 一個 Tool 在 dispatch 前因 input 過大或 policy 而被拒絕
WHEN 呼叫 `executeTyped()`
THEN 回傳 `{ type: "rejected_before_dispatch", errorCode }`
AND MUST NOT 呼叫下游

#### Scenario: 已送出但結果不明回傳 ambiguous_after_dispatch

GIVEN 一個 Tool 已 dispatch 且下游可能已 commit
AND 回應遺失或 timeout
WHEN 呼叫 `executeTyped()`
THEN 回傳 `{ type: "ambiguous_after_dispatch", errorCode }`
AND Runner MUST 依此進入 reconciliation，而非直接重試

#### Scenario: 取消回傳 cancelled 並含 dispatchState

GIVEN 一個 Tool 執行因外部取消訊號中止
WHEN 呼叫 `executeTyped()`
THEN 回傳 `{ type: "cancelled", dispatchState }`
AND `dispatchState` MUST 為 `"before"`、`"after"` 或 `"unknown"` 之一

#### Scenario: legacy 字串只在最外層相容 adapter 產生

GIVEN 既有 LangChain tool-calling 需要字串錯誤
WHEN 相容層需要將 typed outcome 轉為字串
THEN 字串 MUST 只在最外層 legacy adapter 產生
AND Runner 核心 MUST 全程使用 typed outcome

---

### Requirement: SideEffectToolDescriptor MUST 提供 business-effect key 與 reconciler contract

Generic runtime MUST NOT 硬編碼 tool 名稱或 resource key 規則；Tool 必須透過 `SideEffectToolDescriptor` 提供 `deriveBusinessEffectKey`、可選的 `reconcile` 與 `resultReferencePolicy`。

#### Scenario: runtime 透過 descriptor 導出 business effect key

GIVEN 一個 side-effect Tool 註冊了 `SideEffectToolDescriptor`
WHEN runtime 需要計算 `businessEffectKey`
THEN MUST 呼叫 `descriptor.deriveBusinessEffectKey(input, scope)`
AND MUST NOT 以固定 tool 名稱或 resource key 規則自行推導

#### Scenario: descriptor 無 reconciler 時 ambiguous outcome 停止自動 retry

GIVEN 一個 side-effect Tool 的 descriptor 未提供 `reconcile`
AND 執行結果為 `ambiguous_after_dispatch` 或 `unknown`
WHEN runtime 處理該結果
THEN MUST 停止自動 retry
AND MUST 進入 persisted defer／manual 路徑

---

### Requirement: 資料模型 MUST 表達「多 replay、單一 business effect」

資料模型 MUST 分離 `business_effects`、`tool_executions`（logical replay identity）、`tool_execution_attempts`（physical attempts）與 `compensation_executions`。一個 business effect 可對應多個 logical replay/execution。

#### Scenario: 一個 business effect 關聯多個 tool_executions

GIVEN 一個 business effect `E` 已 committed
AND 兩個不同 `replayKey` 的 logical call 皆導出 `E` 的 `businessEffectKey`
WHEN 建立 `tool_executions`
THEN 兩列 `tool_executions` MUST 透過 FK 指向同一 `business_effects` 列
AND MUST NOT 靠覆寫同一列保存不同 replay 的歷史

#### Scenario: physical attempts 為 append-only

GIVEN 一個 `tool_execution` 進行多次 physical dispatch
WHEN 記錄每次 dispatch
THEN MUST 寫入多列 `tool_execution_attempts`（append-only）
AND MUST NOT 覆寫前一 attempt 的紀錄

#### Scenario: 資料關係可重建 replay/attempt/compensation 歷史

GIVEN 完整資料模型
WHEN 需要重建某 business effect 的生命週期
THEN MUST 能從 `business_effects → tool_executions → tool_execution_attempts/reconciliation → compensation_executions` 重建
AND 不遺失 replay alias 或 attempt 歷史

---

### Requirement: Side-effect ledger MUST fail-closed

side-effect Tool 在無法 durable prepare 時 MUST fail-closed，不呼叫下游；只有成功持久化 `prepared` 並取得 effect claim 後才允許 dispatch。純讀取／無副作用 Tool 可明確配置使用 legacy path。

#### Scenario: ledger 不可用時 side-effect Tool 不執行

GIVEN `business_effects`／`tool_executions` 的 durable prepare 因 PostgreSQL 故障而失敗
AND 目標為 side-effect Tool
WHEN 嘗試執行
THEN MUST NOT 呼叫下游
AND MUST 回傳型別化 `SIDE_EFFECT_LEDGER_UNAVAILABLE`
AND 供上層 defer／retry

#### Scenario: 純讀取 Tool 走 legacy path

GIVEN 一個純讀取／無副作用 Tool
AND 已明確配置為 legacy path
WHEN 執行該 Tool
THEN MUST 不經過 business_effects claim
AND 仍可正常執行（不含 side-effect 保護）

#### Scenario: 只有成功 claim 後才 dispatch

GIVEN 一個 side-effect Tool
WHEN 進行 durable prepare
THEN MUST 在 `prepared` 持久化且取得 effect claim 後才 dispatch
AND MUST NOT 在 prepare 尚未成功前呼叫下游

---

### Requirement: requestHash 不一致 MUST 回傳 conflict，不得重用舊結果

當同一 `replayKey` 命中既有 `tool_executions` 但 `requestHash` 不一致時，MUST 回傳 conflict，MUST NOT 重用舊結果。

#### Scenario: 同一 replayKey 但 requestHash 不同

GIVEN 一個既有 `tool_executions` 其 `replayKey = K` 且 `requestHash = H1`
AND 新的 call 產生相同 `replayKey = K` 但 `requestHash = H2`（H2 ≠ H1）
WHEN runtime 查詢並比較 requestHash
THEN MUST 回傳 conflict
AND MUST NOT 回傳舊的 cached result

---

### Requirement: externalOperationId MUST 以複合鍵保證唯一，非全域唯一

`externalOperationId` MUST NOT 全域唯一；MUST 以 `(external_system_namespace, external_operation_id)` 複合唯一鍵標識外部操作。

#### Scenario: 不同外部系統可有相同 operation ID

GIVEN 兩個不同外部系統（`namespace = "payment"` 與 `namespace = "crm"`）
AND 兩者皆回傳 `external_operation_id = "op-123"`
WHEN 寫入 business_effects
THEN 兩筆 MUST 可同時存在（複合鍵 `(namespace, operation_id)` 不同）
AND MUST NOT 因 `operation_id` 重複而衝突

---

### Requirement: Reconciliation MUST 依三態決定 reuse／retry／defer

當 Tool execution 為 `unknown`（ambiguous outcome），runtime MUST 呼叫 reconciler，依 `committed`／`not_committed`／`unknown` 三態決定不重試／依 Retry Budget 重試／停止自動 replay 並 persisted defer。

#### Scenario: 下游已 commit，不重複 retry

GIVEN 下游 commit 成功但 response 遺失，ToolExecution 為 `unknown`
WHEN reconciler 回傳 `{ state: "committed" }`
THEN MUST persist 結果
AND MUST NOT 重複 retry

#### Scenario: 下游未 commit，依 Retry Budget retry

GIVEN reconciler 回傳 `{ state: "not_committed" }`
AND X2 Retry Budget 允許重試
WHEN runtime 決定下一步
THEN MUST 建立新的 physical attempt 並重試

#### Scenario: 結果仍未知，停止自動 replay

GIVEN reconciler 回傳 `{ state: "unknown" }`
WHEN runtime 決定下一步
THEN MUST 停止自動 replay
AND MUST persisted 升級／defer 路徑

---

### Requirement: Result reference 必須可儲存與解析，不只存 resultRef 欄位

Result reference store MUST 儲存 `payload_ref`、`result_hash` 與 `cache_state`，resolver 依 `cache_state`、authorization scope 與 tool version 判定是否可重用。僅存 `resultRef` 欄位不足以回傳 cached result。

#### Scenario: 可重用時回傳 cached result

GIVEN 一個 result reference 其 `cache_state = "reusable"`
AND authorization scope 與 tool version 相符
WHEN 解析 cached result
THEN MUST 回傳 cached result 而不重複呼叫 Tool

#### Scenario: version 或 authorization mismatch 拒絕重用

GIVEN 一個 result reference 其 tool version 已變更，或 authorization scope 不符
WHEN 解析 cached result
THEN `cache_state` MUST 為 `version_mismatch` 或 `authorization_mismatch`
AND MUST 拒絕重用該 result

---

### Requirement: 補償執行 MUST 持久化，失敗 MUST 轉 manual_intervention_required

補償 plan 建立時 MUST 查詢該 step 已 committed 的 ToolExecution；執行 action 前 MUST 建立 `compensation_execution` prepared record；執行 context MUST 帶入 `toolExecutionId`／`businessEffectId`。補償失敗 MUST 轉 `manual_intervention_required`，MUST NOT 只記錄 failure 後繼續把 step 標成 compensated。

#### Scenario: 補償執行前建立 prepared record

GIVEN 一個 side-effect ToolExecution 已 committed 且需補償
WHEN 建立 compensation plan 並執行該 step 的補償
THEN MUST 查詢該 step 已 committed 的 ToolExecution
AND 執行 action 前 MUST 建立 `compensation_execution` prepared record
AND 執行 context MUST 帶入 `toolExecutionId`／`businessEffectId`

#### Scenario: 補償失敗轉 manual_intervention_required

GIVEN 一個補償 action 執行失敗
WHEN 補償鏈處理該失敗
THEN `compensation_execution.status` MUST 轉為 `manual_intervention_required`
AND MUST NOT 把該 step 標成 `compensated`
AND MUST NOT 僅記錄 failure 後靜默視為完成

#### Scenario: 靜態 registry 不綁定 runtime instance ID

GIVEN 既有 `CompensationRegistry` 為 `stepName → CompensationAction[]` 靜態設定
WHEN 註冊補償動作
THEN MUST NOT 在 action registration 時綁定 runtime instance 的 `toolExecutionId`
AND `toolExecutionId` 只在建立 compensation plan 時由已 committed ToolExecution 查詢取得

---

### Requirement: 無副作用 Tool 與 side-effect Tool 的執行路徑 MUST 分離

純讀取／無副作用 Tool 走 legacy path（可配置），side-effect Tool 走 ledger + claim + reconcile 路徑，兩者 MUST 由 descriptor 明確分類。

#### Scenario: 分類由 descriptor 決定

GIVEN 一個 Tool 未註冊為 side-effect（或標記為 read-only）
WHEN runtime 執行
THEN MUST 走 legacy path，不建立 business_effects claim

---

### Requirement: 相關 ID 不得作為 metric labels

`requestId`、`replayKey`、`businessEffectKey` MUST NOT 作為 metric labels（高基數）。可作 trace attributes 與 structured audit fields。若 `businessEffectKey` 可能含資源名稱或 PII，MUST 記錄 hash／opaque ID。

#### Scenario: businessEffectKey 以 hash 記錄

GIVEN 一個 `businessEffectKey` 可能含資源名稱或 PII
WHEN 記錄至 audit 或 trace
THEN MUST 記錄 hash／opaque ID
AND MUST NOT 存 raw key

#### Scenario: ID 不用作 metric label

GIVEN 需要輸出 metric
WHEN 選擇 label
THEN MUST NOT 以 `requestId`、`replayKey`、`businessEffectKey` 作為 metric label

---

### Requirement: Tool Governance MUST 提供型別化執行結果，且保留 legacy 相容層

`tool-governance` MUST 提供 `executeTyped()` 回傳 `GovernedToolOutcome`（discriminated union），並保留 `governedInvoke` 作為最外層 legacy LangChain 相容 adapter；Runner 一律使用 `executeTyped()`，不解析錯誤字串。

#### Scenario: executeTyped 與 governedInvoke 並存

GIVEN `tool-governance` 既有 `governedInvoke` 相容 LangChain tool-calling
WHEN 需要 typed outcome
THEN MUST 提供 `executeTyped()` 回傳 typed outcome
AND `governedInvoke` MUST 保留為最外層 legacy 相容 adapter
AND Runner MUST 使用 `executeTyped()` 而非解析字串

---

### Requirement: BFF MUST 收斂 idempotency header 的 CORS 與驗證

BFF MUST 在 CORS `access-control-allow-headers` 加入 `x-idempotency-key`，並加入長度／格式／重複 header 驗證與 trusted tenant／principal／route namespace，定義 canonical 名稱與具上下限的 TTL 設定。

#### Scenario: CORS allow-headers 包含 idempotency header

GIVEN 瀏覽器發出跨源請求並攜帶 `x-idempotency-key`
WHEN BFF 回傳 CORS 標頭
THEN `access-control-allow-headers` MUST 包含 `x-idempotency-key`

#### Scenario: 重複 header 被驗證

GIVEN 請求攜帶多個 `x-idempotency-key` header
WHEN BFF 驗證
THEN MUST 依定義的規則處理（拒絕或明確衝突）
AND MUST NOT 靜默取第一個值

#### Scenario: TTL 為具上下限的設定值

GIVEN 需要設定 request-dedup TTL
WHEN 讀取設定
THEN MUST 使用具上下限的設定值（覆蓋 BFF retry／timeout window）
AND MUST NOT 使用無來源依據的固定值

#### Scenario: 無 header 時不宣稱防止再次提交

GIVEN 請求未攜帶 idempotency header
WHEN runtime 決定 requestDedupKey
THEN `requestDedupKey` MUST 保持 absent，或明確定義 requestId-derived key 只保護同一 BFF request 的 upstream retry
AND MUST NOT 宣稱能防止使用者再次提交（新 request 通常取得新 requestId）

---

### Requirement: 補償結果語意 MUST 加入 manual_intervention_required

`saga-orchestrator` 的 `resolveOverallStatus` MUST 支援 `manual_intervention_required` 語意，且 action 失敗時不得把 step 標為 `compensated`。

#### Scenario: action 失敗後 step 不標 compensated

GIVEN 一個補償 action 失敗
WHEN orchestrator 處理該 step
THEN step status MUST NOT 標為 `compensated`
AND 結果 MUST 反映 `manual_intervention_required`

### Requirement: 去重結果 MUST 在 governed outcome 中可觀察

當 side-effect 執行重用已提交的 business effect 結果，或因同一 business effect 正在進行或結果未知而未取得 claim 時，governed tool outcome MUST 以共用 harness 契約中專屬的去重結果類型表達，至少包含去重原因與原 business effect 參照；重用已提交結果時 MUST 一併帶回原結果。去重原因 MUST 區分「重用已提交結果」「原操作進行中」「原操作結果未知」。去重 MUST NOT 被映射為一般成功、一般失敗或 dispatch 前拒絕。去重時 MUST NOT 再次呼叫外部系統。未取得 claim 的重複提交所留下的執行紀錄 MUST 可與已 dispatch 但結果未知的執行區分，MUST NOT 觸發 reconciliation 或建立 reconciliation task；同一 replay key 重播時 MUST 依原 business effect 的目前狀態決定去重結果。原 business effect 已釋放時 MUST NOT 判定為去重。去重結果類型 MUST 只由明確選擇接收的 dispatch 來源取得；未選擇接收的既有呼叫者 MUST 得到與變更前相同的結果與錯誤碼。去重 MUST NOT 被計為 circuit breaker 的失敗。

#### Scenario: 重用已提交結果

- **GIVEN** 某 business effect 已提交，且結果可重用
- **WHEN** 另一個 logical tool call 以相同 business effect key 執行，且 dispatch 來源選擇接收去重結果
- **THEN** outcome MUST 為去重，原因為重用已提交結果，附原 business effect 參照與原結果
- **AND** 外部系統 MUST NOT 被再次呼叫

#### Scenario: 並行重複且原操作進行中

- **GIVEN** 某 business effect 已被另一次執行 claim 且尚未提交
- **WHEN** 相同 business effect key 的第二次執行到達
- **THEN** outcome MUST 為去重且標記為進行中重複，附原 business effect 參照
- **AND** outcome MUST NOT 為 dispatch 前拒絕或一般失敗，外部系統 MUST NOT 被呼叫

#### Scenario: 進行中重複的提交被重播

- **GIVEN** 某次提交因原 business effect 進行中而得到進行中重複的去重結果
- **WHEN** 該提交的同一 replay key 因 checkpoint 恢復而重播
- **THEN** outcome MUST 依原 business effect 的目前狀態回傳去重結果：已提交為重用已提交結果、仍在進行為原操作進行中、結果未知為原操作結果未知
- **AND** MUST NOT 回傳需要 reconciliation 或未知結果，MUST NOT 建立 reconciliation task

#### Scenario: 同一 replay 但 request 不一致

- **GIVEN** 同一 replay key 已有執行紀錄
- **WHEN** 以不同 request hash 再次執行
- **THEN** outcome MUST 仍為既有的 replay conflict
- **AND** MUST NOT 被標記為去重

#### Scenario: 既有 graph 不受影響

- **GIVEN** 既有 graph 使用唯讀 tool，或其 dispatch 來源未選擇接收去重結果
- **WHEN** 執行既有 tool 流程，包含重用已提交結果與進行中重複
- **THEN** 其結果形狀與錯誤碼 MUST 與變更前一致：重用已提交結果為一般成功並帶原結果，進行中重複為既有的 dispatch 前拒絕錯誤碼

#### Scenario: 去重不觸發 circuit breaker

- **GIVEN** 某 tool 連續得到去重結果
- **WHEN** circuit breaker 記錄結果
- **THEN** 去重 MUST NOT 被計為失敗，MUST NOT 使 circuit 開啟

#### Scenario: 無法處理去重結果類型的消費者

- **GIVEN** 某消費者對 governed outcome 做窮舉處理，且尚未處理去重結果類型
- **WHEN** 收到去重結果
- **THEN** 消費者 MUST fail-closed，MUST NOT 把去重當作成功或靜默忽略

#### Scenario: ledger 不可用

- **GIVEN** side-effect ledger 無法連線
- **WHEN** 執行 side-effect tool
- **THEN** outcome MUST fail-closed 為 ledger 不可用
- **AND** MUST NOT 被標記為去重或成功

---

### Requirement: 確定未提交即結束的執行 MUST 釋放 business effect claim

執行在取得 claim 後，若以確定未提交的結果結束（授權拒絕、dispatch 前拒絕、dispatch 前取消、tool 回報未提交，或 reconciliation 確認未提交），系統 MUST 在單一集中出口將該 business effect 轉為已釋放，並將持有 claim 的執行轉為失敗。結果未知、已提交或持久化不確定時 MUST NOT 釋放。之後同一 business effect key 的新提交 MUST 能以 compare-and-set 重新占用已釋放的效果，並行的重新占用 MUST 只有一個成功。重新占用 MUST 只由新的、已重新授權的提交觸發，MUST NOT 成為自動重試。

#### Scenario: 未提交失敗後重新提交

- **GIVEN** 某次執行取得 claim 後，tool 回報未提交的失敗
- **WHEN** 之後同一 key 的新提交經授權後執行
- **THEN** 原 business effect MUST 已為已釋放，新提交 MUST 重新占用並執行一次
- **AND** MUST NOT 被判定為進行中重複

#### Scenario: 已取得 claim 但尚未 dispatch 時取消

- **GIVEN** 某次執行已取得 claim、尚未呼叫外部系統
- **WHEN** 執行被取消
- **THEN** business effect MUST 被釋放，結果 MUST 為 dispatch 前取消
- **AND** 外部系統 MUST NOT 被呼叫

#### Scenario: 結果未知不釋放

- **GIVEN** 某次執行已呼叫外部系統且結果無法判定
- **WHEN** 執行結束
- **THEN** business effect MUST NOT 被釋放，MUST 進入未知結果
- **AND** 之後同一 key 的提交 MUST NOT 重新占用該效果

#### Scenario: reconciliation 確認未提交

- **GIVEN** 某次執行結果未知，reconciliation 確認外部系統未提交
- **WHEN** reconciliation 完成
- **THEN** 結果 MUST 為未提交的失敗且 MUST NOT 自動重試
- **AND** business effect MUST 被釋放

#### Scenario: 並行重新占用

- **GIVEN** 某 business effect 已釋放
- **WHEN** 同一 key 的兩個新提交並行執行
- **THEN** MUST 只有一個重新占用成功並呼叫外部系統
- **AND** 另一個 MUST 得到進行中重複的去重結果

#### Scenario: 釋放寫入失敗

- **GIVEN** 某次執行以確定未提交的結果結束（例如 tool 回報訂單不存在，或 dispatch 前取消）
- **WHEN** 釋放 business effect 的寫入失敗
- **THEN** 結果 MUST NOT 為一般的未提交失敗或取消，MUST 為持久化不確定
- **AND** 開啟 reconciliation task 的來源 MUST 建立 reconciliation task
- **AND** MUST NOT 重新 dispatch，MUST NOT 自動重試

#### Scenario: 執行逾時但確定未 dispatch

- **GIVEN** 某次執行在呼叫外部系統之前因逾時而結束
- **WHEN** 執行結束
- **THEN** business effect MUST 被釋放，結果 MUST 為未提交的失敗

---

### Requirement: 已預先完成的授權 MUST 攜帶已消費的決策識別

授權已在 dispatch 前完成（例如經人工審批）時，dispatch MUST 攜帶該次已消費授權決策的識別，執行紀錄 MUST 連結該識別。決策識別 MUST 只來自 server 端已消費的授權紀錄，MUST NOT 來自模型輸出、tool input 或客戶端可提供的設定。有副作用的 dispatch 在取得 claim 之前 MUST 以 server 端紀錄驗證該識別：決策必須存在且為允許、屬於本次執行的 principal 與 scope、屬於本次 tool；若來自人工審批，必須已核准、已消費且屬於本次 tool call。缺少或無法驗證決策識別時 MUST 在取得 claim 之前以 typed failure 拒絕，MUST NOT 留下 claim。

#### Scenario: 審批後執行

- **GIVEN** 某 side-effect 呼叫已經人工審批並消費
- **WHEN** dispatch 執行
- **THEN** 執行 MUST 成功取得 claim 並呼叫外部系統
- **AND** 執行紀錄 MUST 連結已消費的決策識別

#### Scenario: 缺少決策識別

- **GIVEN** dispatch 宣告授權已預先完成，但沒有決策識別
- **WHEN** 執行
- **THEN** MUST 在取得 claim 前以 typed failure 拒絕
- **AND** ledger MUST NOT 有新的 claim，外部系統 MUST NOT 被呼叫

#### Scenario: 偽造或挪用的決策識別

- **GIVEN** dispatch 帶有一個不存在、屬於其他 principal 或 scope、屬於其他 tool 或 tool call、尚未核准或已撤回的決策識別
- **WHEN** 有副作用的 tool 執行
- **THEN** MUST 在取得 claim 前以 typed failure 拒絕並記錄 audit
- **AND** ledger MUST NOT 有新的 claim，外部系統 MUST NOT 被呼叫

#### Scenario: 客戶端設定中夾帶決策識別

- **GIVEN** 客戶端在 run 設定中放入決策識別
- **WHEN** 預先授權的 dispatch 執行
- **THEN** 該值 MUST NOT 被採用

#### Scenario: 取消發生在 claim 之前

- **GIVEN** 已審批的呼叫在取得 claim 前收到中止訊號
- **WHEN** 執行
- **THEN** MUST 在 claim 前結束為 dispatch 前取消
- **AND** ledger MUST NOT 有新的 claim

---

### Requirement: 已釋放與未取得 claim 的表達 MUST 與舊版 runtime 並存

已釋放的 business effect 與未取得 claim 的執行紀錄 MUST 以新增欄位表達，既有狀態欄位 MUST 只寫入既有值。支援這些表達的 schema 變更 MUST 只新增欄位或資料表。部署期間仍在運作的舊版 runtime 讀取這些紀錄時 MUST NOT 失敗，且 MUST NOT 因此重複呼叫外部系統。

#### Scenario: 舊版 runtime 讀取已釋放的效果

- **GIVEN** 新版 runtime 已將某 business effect 釋放
- **WHEN** 舊版 runtime 以相同 key 處理新的提交
- **THEN** 舊版 runtime MUST NOT 因讀取該效果而失敗
- **AND** 外部系統 MUST NOT 被重複呼叫

#### Scenario: 舊版 runtime 讀取未取得 claim 的執行紀錄

- **GIVEN** 新版 runtime 為未取得 claim 的提交寫入了執行紀錄
- **WHEN** 舊版 runtime 進行取消判定或重播
- **THEN** 舊版 runtime MUST NOT 因該紀錄失敗
- **AND** MUST NOT 將該紀錄判定為已提交

#### Scenario: migration 只新增

- **GIVEN** 支援已釋放與未取得 claim 表達的 migration
- **WHEN** 執行 additive migration 檢查
- **THEN** 檢查 MUST 通過，migration MUST NOT 移除或改名既有欄位與 constraint

---

### Requirement: 同時寫入 business effect 與執行紀錄的路徑 MUST 以一致順序加鎖

提交、釋放與重新占用在同一交易中同時寫入 business effect 與執行紀錄時，MUST 以相同順序取得鎖：先 business effect，再執行紀錄。

#### Scenario: 提交、釋放與重新占用並行

- **GIVEN** 同一 business effect 上有提交、釋放或重新占用並行發生
- **WHEN** 各交易執行
- **THEN** MUST NOT 發生資料庫死鎖
- **AND** 每個狀態轉移 MUST 只有一個成功，其餘依新狀態得到明確結果
