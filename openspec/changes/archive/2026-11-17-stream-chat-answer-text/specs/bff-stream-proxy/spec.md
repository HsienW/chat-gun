## ADDED Requirements

### Requirement: BFF MUST disable intermediary buffering for SSE passthrough

當上游回應為 SSE 串流時，BFF MUST 明確宣告中介層不得緩衝或轉換串流內容，且 BFF 自身 MUST NOT 以壓縮或聚合延後轉送。

#### Scenario: 上游為 SSE 串流

- GIVEN 上游回應媒體型別為 SSE 串流
- WHEN BFF 開始轉送
- THEN 下游回應 MUST 宣告停用代理緩衝（`X-Accel-Buffering: no`）
- AND MUST 宣告 `Cache-Control: no-cache, no-transform`

#### Scenario: 首框在上游暫停時已轉送

- GIVEN 上游送出第一框後暫停
- WHEN 下游讀取
- THEN 下游 MUST 已收到第一框
- AND MUST NOT 等待上游後續資料才轉送

#### Scenario: 非 SSE 回應不受影響

- GIVEN 上游回應不是 SSE 串流
- WHEN BFF 轉送
- THEN 既有 header 行為 MUST 不變
