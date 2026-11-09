## MODIFIED Requirements

### Requirement: mandatory dependency 於 dispatch 前 unavailable MUST fail-closed

ledger、authorization、retry、Task/Step 等 mandatory dependency 於 dispatch 前 unavailable 時 MUST fail-closed（deny/defer，不 dispatch）；audit／telemetry exporter 失敗不得抹除已發生 outcome。

#### Scenario: mandatory dependency 缺失不 dispatch

GIVEN 一個 protected dispatch 即將執行
AND 任一 mandatory dependency（ledger／authorization／retry／Task-Step）unavailable
WHEN 執行 dispatch pipeline
THEN MUST fail-closed 且不 dispatch 下游 Tool

#### Scenario: mandatory dependency 未提供時以 dependency unavailable 拒絕

GIVEN 一個 protected dispatch 即將執行
AND 呼叫端未提供某 mandatory dependency，且 production default 亦無法組裝該 dependency
WHEN 執行 dispatch pipeline
THEN outcome MUST 為 `rejected_before_dispatch`，errorCode 為 `TOOL_DISPATCH_DEPENDENCY_UNAVAILABLE`
AND MUST NOT dispatch 下游 Tool

#### Scenario: Task-Step dependency 已組裝但啟動失敗時以 task step unavailable 拒絕

GIVEN 一個 protected dispatch 即將執行
AND Task-Step dependency 已提供（由呼叫端或 production default 組裝）
AND 該 dependency 於啟動 step 時失敗（例如持久層無法連線或逾時）
WHEN 執行 dispatch pipeline
THEN outcome MUST 為 `rejected_before_dispatch`，errorCode 為 `TASK_STEP_UNAVAILABLE`
AND MUST NOT dispatch 下游 Tool

#### Scenario: audit exporter 失敗不抹除 outcome

GIVEN 一個 Tool 已成功 dispatch 且產生 outcome
AND audit／telemetry exporter 於寫入時失敗
WHEN 執行 pipeline 收尾
THEN MUST 不抹除 execution outcome
AND protected dispatch 是否可續行由本地 durable audit policy 決定
