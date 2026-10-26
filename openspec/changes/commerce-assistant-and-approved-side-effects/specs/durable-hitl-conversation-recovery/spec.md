## MODIFIED Requirements

### Requirement: resume 只回到預期 waiting Task 且最多消費一次

Resume MUST 只 resume 到預期的 waiting Task，且回應最多消費一次（atomic consume）。resume 前 MUST 驗證 `interruptId`、`runId`、`taskId`、`scopeId` 與 `executionManifest` 相容；mismatched、expired、replayed 的 resume MUST 拒絕並 audit。一次性憑證 MUST NOT 單獨作為 bearer credential 授權：confirmation 的一次性憑證即 X13 `approvalId`（單一來源、單一消費），clarification 的一次性消費由 manifest `status` 的 atomic transition 強制；MUST NOT 另造並存的第二 token。

`runId` 的驗證對象 MUST 是伺服器端的權威 correlation，而非承載 resume 的執行 run：confirmation 以審批紀錄與 manifest 記錄的等待中 run 為準，且 resume MUST 發生在 manifest 所屬的同一 thread；clarification 以 active run ownership 為準。承載 resume 的執行 run 由 Agent Server 為每次請求產生，MUST NOT 取代 manifest 記錄的 Run／Task correlation。

#### Scenario: resume 回到預期 Task

- **GIVEN** Task `K` 處於 `waiting_confirmation` 且有 durable manifest
- **AND** 使用者送出 scoped resume，由新的執行 run 承載
- **WHEN** 執行 resume
- **THEN** MUST resume 到 Task `K`
- **AND** MUST NOT 另建新 Task，manifest 記錄的 Run／Task correlation MUST 維持不變

#### Scenario: confirmation resume 消費 X13 approvalId（無第二 token）

- **GIVEN** 一個 `kind = "confirmation"` 的 manifest
- **AND** resume 提供 X13 `approvalId`
- **WHEN** 執行 resume
- **THEN** MUST 以 X13 decision store 的 atomic consume 為權威
- **AND** manifest MUST 以 `decisionRef.approvalId` 對齊同一值
- **AND** MUST NOT 另有一組並存的 resume token

#### Scenario: clarification resume 以 interruptId 定位 manifest（MIN-02）

- **GIVEN** 一個 `kind = "clarification"` 的 manifest 處於 `waiting`
- **AND** 使用者以 `NormalizedAgentInput` 送出 `clarification_resume`（含 `interruptId`）
- **WHEN** 執行 resume
- **THEN** MUST 以 `interruptId` 定位該 manifest
- **AND** MUST 驗證 `runId`／`taskId`／`scopeId` 一致
- **AND** 一次性消費 MUST 由 manifest `status` 的 atomic transition（`waiting → resumed`）強制

#### Scenario: 已消費憑證重用被拒

- **GIVEN** 一個 resume 憑證已完成 atomic consume（confirmation → decision store；clarification → manifest status）
- **WHEN** 以同一憑證再次 resume
- **THEN** MUST 拒絕
- **AND** MUST audit

#### Scenario: 等待中 run 不一致、跨 thread 或 expired resume 被拒

- **GIVEN** resume 定位到的 manifest，其 `runId`／`taskId` 與伺服器端權威 correlation 不符，或 resume 所在的 thread 與 manifest 不同，或 manifest 已過期
- **WHEN** 執行 resume
- **THEN** MUST 拒絕
- **AND** MUST NOT dispatch 或推進 Graph

#### Scenario: resume payload 無效時 fail-safe

- **GIVEN** resume payload 未通過預期回應 schema
- **WHEN** 執行 resume
- **THEN** MUST 維持 waiting 或 fail-safe
- **AND** MUST NOT 推進 Graph
