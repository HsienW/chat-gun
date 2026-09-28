# durable-hitl-conversation-recovery Specification

## Purpose

定義跨 process failure 存活的 durable HITL、resume sanitization 與 crash-safe conversation recovery 契約。以 LangGraph native interrupt/checkpoint（X11）為權威，為 confirmation 與 clarification 兩類 interrupt 建立統一 durable manifest、resume 前 protocol-validity 消毒、last-execution-point 分類與 crash terminal policy，使 approval、clarification、interruption、cancellation、resume 存活於 process failure，且不重放不安全工作或 protocol-invalid 歷史。

## Requirements

### Requirement: 統一 DurableInterruptManifest 持久化

Backend MUST 為 confirmation 與 clarification 兩類 interrupt 建立單一 `DurableInterruptManifest`，持久化 `interruptId`、`kind`、Run/Task/Step correlation、`scopeId`、`expectedResponseSchemaRef`、`expiryAt`、`executionManifest`、`status` 與 `decisionRef`（僅 confirmation，連結 X13 決策）。LangGraph checkpoint MUST 仍為 interrupt/resume 的執行權威；manifest 只補充 waiting/recovery 語意，MUST NOT 複製 native scheduling。

#### Scenario: confirmation interrupt 持久化 manifest

GIVEN 一個 `require_confirmation` 決策進入 interrupt
WHEN 進入 confirmation 流程
THEN MUST 產生 serialized LangGraph `interrupt()`
AND MUST 持久化 `DurableInterruptManifest`（`kind = "confirmation"`、correlation、scope、expiry、resume manifest）
AND `status` MUST 為 `waiting`

#### Scenario: clarification interrupt 持久化 manifest

GIVEN 一個 clarification interrupt 產生
WHEN 進入 clarification 流程
THEN MUST 持久化 `DurableInterruptManifest`（`kind = "clarification"`、附 `interruptId` 與預期回應 schema）
AND MUST NOT 僅以 in-memory `interruptId` 傳遞而無 durable 紀錄

#### Scenario: manifest 欄位缺失 fail-closed

GIVEN 一個 interrupt manifest 缺 `interruptId`、`runId`、`taskId` 或 `scopeId`
WHEN 寫入或讀取
THEN MUST fail-closed
AND MUST NOT 以空值或推導值補齊

#### Scenario: manifest 不複製 Run store

GIVEN durable manifest 已建立
WHEN 檢查其職責
THEN MUST 只補 waiting/recovery 語意
AND MUST NOT 建立或取代 LangGraph checkpoint、Run queue 或 worker assignment 權威

#### Scenario: confirmation manifest 連結 X13 決策而非另造 token（MAJ-01）

GIVEN 一個 `kind = "confirmation"` 的 interrupt
WHEN 持久化 manifest
THEN MUST 以 `decisionRef`（`decisionId` + `approvalId`）連結 X13 既有決策
AND MUST NOT 在 manifest 內另造一個並存的 resume token
AND 一次性消費的權威 MUST 仍為 X13 decision store

---

### Requirement: resume 只回到預期 waiting Task 且最多消費一次

Resume MUST 只 resume 到預期的 waiting Task，且回應最多消費一次（atomic consume）。resume 前 MUST 驗證 `interruptId`、`runId`、`taskId`、`scopeId` 與 `executionManifest` 相容；mismatched、expired、replayed 的 resume MUST 拒絕並 audit。一次性憑證 MUST NOT 單獨作為 bearer credential 授權：confirmation 的一次性憑證即 X13 `approvalId`（單一來源、單一消費），clarification 的一次性消費由 manifest `status` 的 atomic transition 強制；MUST NOT 另造並存的第二 token。

#### Scenario: resume 回到預期 Task

GIVEN Task `K` 處於 `waiting_confirmation` 且有 durable manifest
AND 使用者送出 scoped resume
WHEN 執行 resume
THEN MUST resume 到 Task `K`
AND MUST NOT 另建新 Task 或 Run

#### Scenario: confirmation resume 消費 X13 approvalId（無第二 token）

GIVEN 一個 `kind = "confirmation"` 的 manifest
AND resume 提供 X13 `approvalId`
WHEN 執行 resume
THEN MUST 以 X13 decision store 的 atomic consume 為權威
AND manifest MUST 以 `decisionRef.approvalId` 對齊同一值
AND MUST NOT 另有一組並存的 resume token

#### Scenario: clarification resume 以 interruptId 定位 manifest（MIN-02）

GIVEN 一個 `kind = "clarification"` 的 manifest 處於 `waiting`
AND 使用者以 `NormalizedAgentInput` 送出 `clarification_resume`（含 `interruptId`）
WHEN 執行 resume
THEN MUST 以 `interruptId` 定位該 manifest
AND MUST 驗證 `runId`／`taskId`／`scopeId` 一致
AND 一次性消費 MUST 由 manifest `status` 的 atomic transition（`waiting → resumed`）強制

#### Scenario: 已消費憑證重用被拒

GIVEN 一個 resume 憑證已完成 atomic consume（confirmation → decision store；clarification → manifest status）
WHEN 以同一憑證再次 resume
THEN MUST 拒絕
AND MUST audit

#### Scenario: mismatched run 或 expired resume 被拒

GIVEN resume 的 `runId`／`taskId` 與原 manifest 不符，或 manifest 已過期
WHEN 執行 resume
THEN MUST 拒絕
AND MUST NOT dispatch 或推進 Graph

#### Scenario: resume payload 無效時 fail-safe

GIVEN resume payload 未通過預期回應 schema
WHEN 執行 resume
THEN MUST 維持 waiting 或 fail-safe
AND MUST NOT 推進 Graph

---

### Requirement: RecoverySanitizer 於 resume 前驗證 protocol-validity

Recovery 於 resume 前 MUST 以 `RecoverySanitizer` 對持久化歷史執行 protocol-validity 消毒，回 typed `SanitizeResult`（`valid`／`sanitized`／`parked`）。MUST 偵測並處置：unmatched Tool calls/results、incomplete Tool argument fragments、orphaned thinking/content blocks、partial assistant messages、invalid legacy enum/config values、already-terminal Tool results、incompatible execution manifests。MUST 依結構/schema 偵測，MUST NOT 依顯示文案或模型輸出反推；無法證明有效 MUST park 並附 redacted diagnostics，MUST NOT 自行發明 message。

#### Scenario: 偵測 unmatched tool calls/results

GIVEN 持久化歷史含無對應結果的 Tool call，或重複結果
WHEN 執行 sanitize
THEN MUST 歸入 `sanitized` 或 `parked`
AND MUST NOT 以該殘缺歷史直接 replay

#### Scenario: 偵測 incomplete tool argument fragments

GIVEN 歷史含 incomplete Tool argument（X15 decode 的 `incomplete`／`invalid`）
WHEN 執行 sanitize
THEN MUST 不將其視為合法 Tool 輸入
AND MUST 安全刪除或 park

#### Scenario: 偵測 orphaned 或 partial message

GIVEN 歷史含 orphaned thinking/content block 或 partial assistant message
WHEN 執行 sanitize
THEN MUST 移除殘缺片段（`sanitized`）或 park
AND MUST NOT 還原出 protocol-invalid 的 message 序列

#### Scenario: 偵測 already-terminal 與 invalid legacy 值

GIVEN 歷史含 already-terminal Tool result，或 invalid legacy enum/config 值
WHEN 執行 sanitize
THEN MUST 不續用 already-terminal result
AND invalid legacy 值 MUST 以 stable mapping 修正或 park，MUST NOT 靜默保留

#### Scenario: 偵測 incompatible execution manifests（MAJ-02）

GIVEN 一個 interrupt manifest 的 `executionManifest` 與目前部署的 manifest
WHEN 執行 sanitize 的相容性判斷
THEN 同 `manifestVersion` major + 同 `graphId` + 同 `graphConfigHash` MUST 判為 `compatible`
AND `schemaVersions` 僅 minor/patch 差異 MUST 判為 `migratable`
AND `manifestVersion` major 差異或 `graphId`／`graphConfigHash` 不符 MUST 判為 `incompatible`
AND `incompatible` MUST migrate、pin 或 park，MUST NOT blind replay

#### Scenario: 無法證明有效時 park 且不 invent message

GIVEN sanitizer 無法證明歷史 protocol-validity
WHEN 執行 sanitize
THEN MUST 回 `parked` 並附 redacted diagnostics
AND MUST NOT 合成或發明 message 以填補缺口

---

### Requirement: LastExecutionPointClassifier 分類最後持久化進度

Recovery MUST 以持久化 Task/Step 狀態、side-effect ledger、checkpoint 與 manifest 分類 last durable execution point 為 `not_started`／`executing`／`committed`／`unknown`／`terminal`／`waiting_user`。分類 MUST 以 stable machine identifier 為基礎，MUST NOT 以自然語言或顯示文案推斷。

#### Scenario: 六種分類皆可判定

GIVEN 一份持久化的執行狀態
WHEN 執行分類
THEN MUST 回 `not_started`／`executing`／`committed`／`unknown`／`terminal`／`waiting_user` 其中之一
AND MUST NOT 拋出未處理錯誤或回未定義

#### Scenario: sanitizer parked 時不執行 classifier（MAJ-03）

GIVEN `RecoverySanitizer` 回 `parked`
WHEN recovery 執行
THEN MUST 不執行 classifier
AND MUST 直接收斂至 `manual_intervention_required`
AND MUST NOT invent message 或 resume

#### Scenario: classifier 以 durable 證據分類而非 message 歷史（MAJ-03）

GIVEN sanitizer 已刪除部分 message 片段（`sanitized`）
AND 持久化的 committed mutation 證據在 side-effect ledger／checkpoint
WHEN 執行分類
THEN classifier MUST 以 Task/Step 狀態、ledger、checkpoint、manifest 為權威輸入
AND MUST NOT 因 message 片段被刪除而將 committed 誤判為 unknown
AND `SanitizeResult` 的 `reasonCodes`／`dropped` summary MUST 作為 diagnostic 輸入記錄，不作為 committed/unknown 判定來源

#### Scenario: committed/unknown mutation 經 X14 reconciliation

GIVEN 分類為 `committed` 或 `unknown` 且屬 mutation
WHEN recovery 準備 continuation
THEN MUST 先經 X14 `SideEffectReconciler`（`commit`／`retry`／`defer`）
AND MUST NOT 未 reconcile 就重放 side effect

#### Scenario: unknown 且無 reconciler 時 park

GIVEN 分類為 `unknown` 且 mutation Tool 無 `SideEffectReconciler`
WHEN 執行 continuation
THEN MUST 標記 `manual_intervention_required` 並 park
AND MUST NOT blind retry

#### Scenario: terminal 不回 running

GIVEN 分類為 `terminal`
WHEN 收到 late/duplicate/replayed progress
THEN MUST 維持 terminal 且不回 running（X19 單向收斂）

---

### Requirement: cancellation reason 與 transport disconnect 分離

Recovery 紀錄 MUST 分離 `cancellationReason`（`user_cancel`／`timeout`／`supersede`／`crash`）與 `transportDisconnect`。user cancel、client disconnect、timeout、crash、supersede MUST 保持可分離，MUST NOT 以顯示文案或錯誤字串反推。

#### Scenario: user cancel 與 disconnect 可分離

GIVEN 一次執行因 user cancel 終止，另一次因 client disconnect 終止
WHEN 讀取 recovery 紀錄
THEN 兩者 MUST 以不同 stable reason 分離
AND MUST NOT 混為同一分類

#### Scenario: crash 與 timeout 可分離

GIVEN 一次執行因 crash 終止，另一次因 timeout 終止
WHEN 讀取 recovery 紀錄
THEN MUST 以 stable reason code 分離
AND recovery 決策 MUST 依 reason code，不依字串

---

### Requirement: CrashTerminalPolicy 明確定義

fatal corruption 時 backend MUST 停止新 claims、flush bounded telemetry、盡力持久化 crash/recovery state、exit non-zero。本地 redacted diagnostics MUST 與外部 error export 配置分離；外部 export MUST NOT 含 raw 敏感內容。

#### Scenario: fatal corruption 停止新 work

GIVEN 偵測到 fatal runtime corruption
WHEN 執行 CrashTerminalPolicy
THEN MUST 停止新 claims
AND MUST 記錄 recoverable/manual state 或 exit non-zero
AND MUST NOT 繼續 process

#### Scenario: fatal corruption 判定採 stable 條件（MIN-01）

GIVEN 需判定 crash 是否 fatal
WHEN 執行 CrashTerminalPolicy
THEN MUST 依 stable 條件判定：checkpoint store 不可寫入、或 state 結構損毀且無法 deserialize、或 durable 不變量被破壞（terminal 回 running／side-effect 重複 commit 跡象）
AND MUST NOT 依錯誤字串或顯示文案判定
AND bounded telemetry flush MUST 有上限（預設 ≤ 1000 筆、timeout ≤ 2000ms），超過即捨棄並以 redacted reason code 記錄

#### Scenario: recoverable crash 盡力持久化 state

GIVEN 一次非 fatal crash 且仍可寫入
WHEN 執行 CrashTerminalPolicy
THEN MUST 盡力持久化 crash/recovery state 與 bounded telemetry
AND MUST 不抹除已發生 outcome

#### Scenario: 外部 export 不含 raw 敏感內容

GIVEN 外部 error export 已配置
WHEN 匯出 diagnostics
THEN MUST 只含 redacted summary
AND MUST NOT 含 raw credential、token、unmasked PII

---

### Requirement: recovery integration 使用實際 checkpoint

Recovery integration test MUST 使用實際 LangGraph checkpoint，MUST NOT 只以 mock state object 驗證。中斷存活、resume one-time、reconcile routing 與 terminal 收斂 MUST 有可重現證據；無法 live 驗證者 MUST 標記「未驗證」，MUST NOT 假稱通過。

#### Scenario: interrupt 存活於 process restart

GIVEN 一次 interrupt 已持久化
AND process 於等待期間終止並重啟
WHEN recovery 執行
THEN MUST 自實際 checkpoint 恢復該 interrupt
AND 等待語意 MUST 不遺失

#### Scenario: 無法 live 驗證時誠實標記

GIVEN 因環境限制無法以實際 checkpoint 執行某 recovery 情境
WHEN 記錄驗證結果
THEN MUST 標記「未驗證」
AND MUST NOT 以 mock 通過宣稱 live 通過
