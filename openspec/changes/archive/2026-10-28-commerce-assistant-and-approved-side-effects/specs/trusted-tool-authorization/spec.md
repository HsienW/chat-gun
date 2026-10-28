## MODIFIED Requirements

### Requirement: resume MUST 為一次性、scoped，且 Agent MUST NOT 自我批准

confirmation resume MUST 只接受一次性、scoped 的確認決策；一次性 `approvalId` MUST 由具足夠 entropy 的 server-side source 產生，但不得作為單獨即可授權的 bearer credential。批准 MUST 同時驗證 trusted principal、tenant/scope、等待中的 Run、decision、resource、policy version 與 expiry，並以 persistent atomic transition 消耗。Agent MUST NOT 存在可批准自己 HITL 請求的 callable 路徑。expired、replayed、cross-tenant、mismatched-Run 或 mismatched-resource 的 approval MUST 拒絕並 audit。

「等待中的 Run」MUST 以伺服器端保存的 waiting state 為準：審批紀錄與 durable interrupt manifest 記錄的 `runId` MUST 一致，且 resume MUST 發生在該 waiting state 所屬的同一 thread。承載 resume 的執行 run 由 Agent Server 為每次請求產生，其 `runId` MUST NOT 作為與等待中 Run 比對的對象；客戶端提供的任何 run 識別（active-run hint、輸入或設定欄位）MUST NOT 作為批准的依據。消費成功時 audit MUST 同時記錄等待中 Run 與承載 resume 的執行 run，使兩者可互相追溯。

#### Scenario: approvalId 重用被拒

- **GIVEN** 一個已完成 atomic consume 的 approvalId
- **WHEN** 以同一 approvalId 再次 resume，不論由哪一個執行 run 承載
- **THEN** MUST 拒絕
- **AND** MUST audit

#### Scenario: approvalId 單獨持有不得批准

- **GIVEN** resume request 提供有效且未使用的 approvalId
- **AND** request 的 trusted principal、tenant/scope 或 allowed-approver policy 不符合 pending confirmation
- **WHEN** 執行 resume
- **THEN** MUST 拒絕
- **AND** MUST NOT dispatch
- **AND** MUST audit

#### Scenario: 過期 approval 被拒

- **GIVEN** 一個已過期的 confirmation waiting state
- **WHEN** 企圖 resume 放行
- **THEN** MUST 拒絕並視為 deny（`CONFIRMATION_TIMEOUT`）
- **AND** MUST NOT dispatch

#### Scenario: 由新的執行 run 承載的 resume 可被核准

- **GIVEN** 一筆等待中的審批，其審批紀錄與 interrupt manifest 記錄的 `runId` 為原 run
- **AND** resume 經 Agent Server 送達同一 thread，承載它的執行 run 有新的 `runId`
- **AND** trusted principal、tenant/scope、decision、resource、policy version 與期限皆符合
- **WHEN** 執行 resume 並核准
- **THEN** MUST 完成 atomic consume 並 dispatch 一次
- **AND** audit MUST 同時記錄原 run 與承載 resume 的執行 run

#### Scenario: 等待中 Run 不一致、跨 thread 或 mismatched-resource approval 被拒

- **GIVEN** resume 定位到的 waiting state 中，審批紀錄與 interrupt manifest 記錄的 `runId` 不一致，或 resume 所在的 thread 與 waiting state 不同，或 resource 與原 waiting state 不符
- **WHEN** 執行 resume
- **THEN** MUST 拒絕
- **AND** MUST NOT dispatch
- **AND** MUST audit

#### Scenario: 客戶端提供的 run 識別不影響批准

- **GIVEN** 一筆等待中的審批
- **WHEN** resume 請求夾帶任意 active-run hint 或其他客戶端 run 識別（包含與原 run 相同或不同的值）
- **THEN** 批准結果 MUST 只由伺服器端 waiting state 與 trusted identity 決定
- **AND** 該識別 MUST NOT 使原本會被拒絕的 resume 通過

#### Scenario: Agent 無法自我批准

- **GIVEN** 一個由 Agent 觸發的 `require_confirmation` 決策
- **WHEN** Agent 嘗試自行批准該請求
- **THEN** MUST NOT 存在 Agent-callable Tool 可完成自我批准
- **AND** 批准 MUST 由受信控制路徑（或人類）完成並分開 audit
