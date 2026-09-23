# unified-tool-dispatch-pipeline Specification

## Purpose

本規格定義統一 Tool dispatch pipeline 的正式需求：把既有 governance、authorization、retry budget、side-effect ledger、reconciliation、compensation、Task/Step、audit、tracing 原語，組合成一條由 registry 擁有、所有 production Agent 共用的強制 dispatch 路徑，以統一 `RuntimeToolDescriptor` 驅動，並以 architecture test 阻斷直接受保護 Tool invocation。

## Requirements

### Requirement: 每個 production Tool MUST 由統一 RuntimeToolDescriptor 註冊並以單一 registry 供給

每個 production Tool MUST 以統一 `RuntimeToolDescriptor`（`toolName`、`toolVersion`、`inputSchema`、`outputSchema`、`riskTier`、`isReadOnly`、`isConcurrencySafe`、`timeoutPolicy`、`retryPolicy`、`interruptBehavior`、`sideEffect?`）於單一 registry 組裝點註冊；policy 不得散落於各 Tool，亦不得以 Tool 名稱 switch 作為主要 policy 機制。

#### Scenario: 單一 registry 發現所有 production Tool

GIVEN production registry 已建立
WHEN 查詢所有 production Agent Tool
THEN 每個 Tool MUST 具備對應 `RuntimeToolDescriptor`
AND descriptor MUST 由單一 registry 組裝點供給
AND MUST NOT 依 Tool 名稱 switch 決定 policy

#### Scenario: 未註冊 Tool 於 dispatch 前 deny

GIVEN 一個未於 registry 註冊 descriptor 的 Tool
WHEN 執行 dispatch
THEN MUST 於 invocation 前回傳 deny（`UNREGISTERED_TOOL_DENIED`）
AND MUST NOT dispatch

#### Scenario: descriptor 型別不符於註冊時 fail-closed

GIVEN 一個 Tool 的 descriptor 缺少必要欄位或 `toolName`／`toolVersion` 與實際 Tool 不符
WHEN registry 註冊該 Tool
THEN MUST 註冊失敗並 fail-closed
AND MUST NOT 以空值或預設補齊後放行

---

### Requirement: 所有 production Agent Tool MUST 經同一 registry-owned dispatcher 執行

Chatbot、Math、MCP、Deep Research 的 Tool 呼叫 MUST 都經同一 dispatcher；MUST NOT 存在 per-Agent 重複 dispatcher，MUST NOT 存在 production Agent 直接 invoke 受保護 Tool 的分歧路徑。

#### Scenario: 每個 Agent 經同一 dispatcher

GIVEN Chatbot、Math、MCP、Deep Research 需要呼叫 Tool
WHEN 執行 Tool 呼叫
THEN MUST 都經同一 dispatcher 進入 pipeline
AND MUST NOT 各自持有獨立 dispatch 邏輯

#### Scenario: production Agent 不得直接 invoke 受保護 Tool

GIVEN 一個 production Agent 直接 import 並 invoke 受保護 Tool
WHEN 執行 architecture test
THEN MUST fail
AND 該直接 invocation MUST 不得存在於 production 程式碼

---

### Requirement: read-only Tool 走 typed executor，mutation Tool MUST 宣告 side-effect descriptor 才可註冊

read-only Tool MAY 以 typed executor 直接執行（無 ledger）；mutation Tool MUST 在註冊成功前宣告 stable `SideEffectToolDescriptor`（`deriveBusinessEffectKey`、`reconcile`、`resultReferencePolicy`），否則註冊 fail-closed（deny）。

#### Scenario: mutation Tool 缺 side-effect descriptor 不得註冊

GIVEN 一個 mutation Tool 未宣告 `SideEffectToolDescriptor`
WHEN registry 註冊該 Tool
THEN MUST 註冊失敗並 fail-closed
AND MUST NOT dispatch 該 Tool

#### Scenario: mutation Tool 具 descriptor 才可 dispatch

GIVEN 一個 mutation Tool 已宣告合法 `SideEffectToolDescriptor`
AND descriptor 與 Tool identity（`toolName`／`toolVersion`）相符
WHEN 執行 dispatch
THEN MUST 經 side-effect ledger（prepare/claim/commit）執行

#### Scenario: read-only Tool 不進 ledger

GIVEN 一個 `isReadOnly` Tool
WHEN 執行 dispatch
THEN MUST 以 typed executor 執行
AND MUST NOT 建立 side-effect ledger 紀錄

---

### Requirement: 同一 replay key 重放 MUST 複用相容結果而不 redispatch

同一個 replay key 的執行重放 MUST 複用相容已 commit 結果；MUST NOT 重新 dispatch 下游 Tool。

#### Scenario: replay key 命中已 commit 結果

GIVEN 一個 mutation Tool 執行已 commit
AND 以同一 replay key 再次執行
WHEN 執行 dispatch
THEN MUST 自 ledger／result reference 複用已 commit 結果
AND MUST NOT 重新 dispatch 下游 Tool

#### Scenario: replay key 衝突（requestHash 不符）不得複用

GIVEN 同一 replay key 對應不同 `requestHash`
WHEN 執行 dispatch
THEN MUST 回傳 replay conflict
AND MUST NOT dispatch 下游 Tool

---

### Requirement: 同一 business-effect key MUST NOT commit 兩次

同一 business-effect key 即使 request-dedup 已過期，MUST NOT commit 兩次；idempotency 由 durable business-effect identity 保證。

#### Scenario: business-effect key 二次執行不重複 commit

GIVEN 一個 business-effect key 已 commit
AND 以不同 replay key 但同一 business-effect key 再次執行
WHEN 執行 dispatch
THEN MUST 不得再次 commit 該 business effect
AND MUST 回傳相容已 commit 結果或明確 conflict

---

### Requirement: ambiguous timeout MUST 於任何 retry 前 reconcile

dispatch 後 timeout／斷線產生 `ambiguous_after_dispatch` 時，MUST 先經 `SideEffectReconciler` reconcile 判定 committed／not_committed／unknown，再依結果與 retry budget 決定 retry／park；MUST NOT blind retry。

#### Scenario: ambiguous 先 reconcile 再 retry

GIVEN 一個 mutation Tool 於 dispatch 後 timeout
WHEN 執行 dispatch pipeline
THEN MUST 回傳 ambiguous 並先 reconcile
AND retry 只接 `not_committed` 或 external idempotency guarantee
AND MUST NOT 在未 reconcile 前 blind retry

#### Scenario: reconcile 判定 committed 不得重複 dispatch

GIVEN reconcile 判定下游已 commit
WHEN 執行 dispatch pipeline
THEN MUST 複用 committed 結果
AND MUST NOT 重新 dispatch 下游

#### Scenario: 無 reconciler 時 park 而非 blind retry

GIVEN 一個 mutation Tool 未提供 `SideEffectReconciler`
AND 於 dispatch 後 timeout
WHEN 執行 dispatch pipeline
THEN MUST 標記 manual intervention 並 park
AND MUST NOT blind retry

---

### Requirement: authorization deny／cancel／reject／invalid schema／unknown side-effect 不得進入 retry

authorization deny、user cancel、business reject、invalid schema、unknown side-effect state MUST NOT 進入 retry logic；只有非授權且 `not_committed` 的可重試錯誤才可 retry，且 retry 前 MUST 重新評估 authorization。

#### Scenario: authorization deny 不重試

GIVEN 一個 Tool 因 authorization 被 deny
WHEN 執行 dispatch pipeline
THEN MUST NOT 建立新的 physical attempt
AND MUST NOT 進入 retry budget

#### Scenario: failed_not_committed 可 retry 但重估 authorization

GIVEN 一個 `failed_not_committed` outcome
AND retry budget 允許
WHEN 執行 dispatch pipeline
THEN MUST 可 retry
AND retry 前 MUST 重新評估 authorization

---

### Requirement: output-schema 失敗且 effect 已 commit MUST persist effect truth 並分開 park/repair

Tool output MUST 通過 `outputSchema` 才回 `succeeded`；若 output-schema 失敗但 effect 已 commit，MUST 先 persist effect truth（ledger committed + result reference），再分開 park／repair result，不得抹除 execution outcome。

#### Scenario: output-schema 失敗但已 commit 不抹除 outcome

GIVEN 一個 mutation Tool 已 commit 下游 effect
AND 其 output 未通過 `outputSchema`
WHEN 執行 output validation
THEN MUST 持久化已 commit effect truth 與 result reference
AND result MUST 分開 park／repair
AND MUST NOT 抹除 execution outcome

---

### Requirement: mandatory dependency 於 dispatch 前 unavailable MUST fail-closed

ledger、authorization、retry、Task/Step 等 mandatory dependency 於 dispatch 前 unavailable 時 MUST fail-closed（deny/defer，不 dispatch）；audit／telemetry exporter 失敗不得抹除已發生 outcome。

#### Scenario: mandatory dependency 缺失不 dispatch

GIVEN 一個 protected dispatch 即將執行
AND 任一 mandatory dependency（ledger／authorization／retry／Task-Step）unavailable
WHEN 執行 dispatch pipeline
THEN MUST fail-closed 且不 dispatch 下游 Tool

#### Scenario: audit exporter 失敗不抹除 outcome

GIVEN 一個 Tool 已成功 dispatch 且產生 outcome
AND audit／telemetry exporter 於寫入時失敗
WHEN 執行 pipeline 收尾
THEN MUST 不抹除 execution outcome
AND protected dispatch 是否可續行由本地 durable audit policy 決定

---

### Requirement: Tool result MUST 全程維持 structured 並以 versioned envelope 表達

typed execution outcome MUST 轉成 versioned structured tool result；legacy string 只作 presentation 相容層，不得承擔機讀語意；Tool result 於 model feedback、Task event、frontend fallback、audit 全程維持 structured。

#### Scenario: structured result 不經 legacy string 反推狀態

GIVEN 一個 Tool 執行完成
WHEN 產生 Tool result
THEN MUST 以 versioned structured envelope 表達
AND MUST NOT 以 legacy error string 反推機讀狀態

#### Scenario: legacy string 僅為 presentation 相容

GIVEN 一個需要舊 client 相容的 Tool result
WHEN presentation adapter 產生 legacy string
THEN MUST 只作 presentation
AND structured envelope MUST 為機讀單一事實來源

---

### Requirement: concurrency scheduling MUST 依 descriptor 分類，分類失敗不得提升 concurrency

mutation／unknown Tool MUST serial；read-only 且 `isConcurrencySafe(input)` 才可 bounded concurrent；分類拋錯或 input validation 失敗 MUST conservative serial/no-dispatch。

#### Scenario: mutation 與 unknown serial

GIVEN 一個 mutation 或 unknown 分類的 Tool 呼叫
WHEN 執行 scheduling
THEN MUST serial 執行
AND MUST NOT 與其他 mutation 併發

#### Scenario: 分類失敗保守 serial

GIVEN `isConcurrencySafe` 拋錯或 input validation 失敗
WHEN 執行 scheduling
THEN MUST 保守 serial 或 no-dispatch
AND MUST NOT 提升 concurrency

---

### Requirement: 既有 Weather／Web／Calculator／MCP 行為 MUST 保持相容

統一 pipeline 接線 MUST 保持既有 Weather、Web、Calculator、MCP 行為相容；既有 golden eval／mock smoke／live smoke MUST 通過；不變更既有 Graph ID、公開 BFF route 或 error-code 語意。

#### Scenario: 既有行為回歸通過

GIVEN 統一 pipeline 已接線
WHEN 執行既有 Weather／Web／Calculator／MCP 回歸
THEN MUST 通過
AND MUST NOT 變更既有 Graph ID／公開 route／error-code 語意
