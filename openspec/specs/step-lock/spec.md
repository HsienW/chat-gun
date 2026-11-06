# Step Lock 分散式鎖

## Purpose

規範 Step 鎖的擁有者、有效期限與狀態轉移的一致性。來源為[歸檔規格](../../changes/archive/2026-08-03-add-distributed-step-lock/specs/step-lock/spec.md)。部署模式的降級條件沿用 [multi-instance-operation](../multi-instance-operation/spec.md)。

## Requirements

### Requirement: 分散式 Step 鎖獲取與釋放

Redis 支援的 Step 鎖 MUST 依 Step 識別碼與部署設定的 key prefix 識別鎖。在鎖的 TTL 內，同一個鎖 MUST 僅由一個 owner 持有。釋放與續期 MUST 檢查 owner，取得與續期使用的 TTL MUST 為正整數毫秒。Redis 缺少設定時，Noop 降級 MUST 遵守 [multi-instance-operation 的部署模式限制](../multi-instance-operation/spec.md#requirement-multi-instance-模式禁止-noopsteplock)。

#### Scenario: 單一 worker 取得並釋放鎖

- **GIVEN** `step-1` 尚未上鎖，Redis key prefix 可依部署設定配置
- **WHEN** `worker-A` 以 30000 毫秒的 TTL 取得鎖
- **THEN** MUST 回傳 `true`，Redis MUST 以 `worker-A` 為值建立具有該 TTL 的 `${prefix}step_lock:step-1`
- **AND** 持有者釋放成功後 MUST 移除同一個 key

#### Scenario: 其他 worker 競爭有效的鎖

- **GIVEN** `worker-A` 已持有 `step-1` 的有效鎖
- **WHEN** `worker-B` 嘗試取得同一把鎖
- **THEN** MUST 回傳 `false`

#### Scenario: 持有者中斷且 TTL 到期

- **GIVEN** `worker-A` 持有 `step-1` 的鎖，且中斷後未釋放或續期
- **WHEN** TTL 到期後 `worker-B` 嘗試取得鎖，且沒有其他持有者
- **THEN** `worker-B` MUST 能取得鎖

#### Scenario: 非持有者嘗試釋放或續期

- **GIVEN** `worker-A` 持有 `step-1` 的有效鎖
- **WHEN** `worker-B` 嘗試釋放或續期
- **THEN** 鎖及其 TTL MUST NOT 因該操作而變更，續期 MUST 回傳 `false`

#### Scenario: 持有者續期

- **GIVEN** `worker-A` 持有 `step-1` 的有效鎖
- **WHEN** `worker-A` 將 TTL 延長至 60000 毫秒
- **THEN** MUST 回傳 `true` 並更新 TTL

#### Scenario: 單 instance 在未設定 Redis 時降級

- **GIVEN** 部署模式允許單 instance 的 Noop 降級，且未設定 `REDIS_URI`
- **WHEN** 系統建立 Step 鎖並執行取得、釋放或續期
- **THEN** MUST 使用 `NoopStepLock`，取得及續期 MUST 回傳 `true`，釋放 MUST 為 no-op
- **AND** 狀態轉移 MUST 仍由資料庫 CAS 防止競爭寫入

#### Scenario: 多 instance 在缺少 Redis 時拒絕降級

- **GIVEN** 部署政策啟用多 instance，且未設定 shared Redis
- **WHEN** 系統建立 Step 鎖
- **THEN** MUST 回報 `LOCK_INFRASTRUCTURE_UNAVAILABLE`
- **AND** MUST NOT 回退至 `NoopStepLock`

### Requirement: Step Transition Guard 雙重防護

Step Transition Guard MUST 檢查狀態轉移是否合法，再透過 Step 鎖及 PostgreSQL CAS 進行轉移。CAS MUST 以 Step 識別碼及預期的起始狀態為條件。取得鎖後的 best-effort 清理是指 Guard MUST 在結束轉移時嘗試釋放鎖。釋放操作若擲出例外，該例外 MUST 傳回呼叫端。

#### Scenario: 正常轉移成功

- **GIVEN** Step 處於 `pending` 且沒有其他 worker 持鎖
- **WHEN** `worker-A` 將 Step 從 `pending` 轉為 `running`，且取得鎖、CAS 與釋放均成功
- **THEN** MUST 回傳 `success` 與更新後的 Step，且鎖 MUST 已釋放

#### Scenario: 鎖競爭阻止轉移

- **GIVEN** 另一個 worker 持有該 Step 的鎖
- **WHEN** Guard 嘗試取得鎖並得到 `false`
- **THEN** MUST 回傳 `lock_contention`，且 MUST NOT 執行 CAS
- **AND** `currentOwner` 僅在可讀取時以 best-effort 方式回傳

#### Scenario: 資料庫 CAS 偵測到競爭寫入

- **GIVEN** worker 已取鎖，但 Step 在 CAS 前被其他寫入改為 `running`
- **WHEN** Guard 以預期狀態 `pending` 更新，CAS 未更新任何資料，且 Step 在重新讀取時仍存在
- **THEN** Guard MUST 讀回 `currentStatus` 並嘗試釋放鎖
- **AND** 釋放完成時 MUST 回傳 `cas_mismatch` 與讀回的 `currentStatus`
- **AND** 釋放擲出例外時，本次呼叫 MUST 以該例外結束，無法保證回傳 `cas_mismatch`

#### Scenario: 非法狀態轉移

- **GIVEN** Step 已是 `succeeded`
- **WHEN** worker 嘗試將它轉回 `running`
- **THEN** MUST 回傳 `invalid_transition` 與原因，且 MUST NOT 取得鎖或更新狀態

#### Scenario: 取得鎖後嘗試清理

- **GIVEN** Guard 已取得鎖
- **WHEN** CAS 成功、未命中或擲出例外
- **THEN** Guard MUST 在離開轉移流程時嘗試釋放鎖
- **AND** Redis 釋放操作失敗時，MUST NOT 假定鎖已立即移除。未釋放的鎖仍受 TTL 限制

#### Scenario: 嘗試釋放鎖時 Redis 擲出例外

- **GIVEN** Guard 已取得鎖，且 CAS 未命中後已讀回仍存在的 Step 狀態
- **WHEN** Guard 在 `finally` 嘗試釋放鎖，且 Redis 釋放操作擲出例外
- **THEN** Guard 的呼叫 MUST 以該釋放例外結束，且 MUST NOT 回傳先前產生的 `cas_mismatch` 結果

#### Scenario: 單 instance 的 Noop 路徑仍執行 CAS

- **GIVEN** 部署模式允許單 instance 的 Noop 降級，且 Guard 使用 `NoopStepLock`
- **WHEN** worker 嘗試合法的 Step 狀態轉移
- **THEN** 鎖取得 MUST 放行，Guard MUST 仍以預期狀態執行 CAS

#### Scenario: Redis 在取得鎖時中斷

- **GIVEN** Guard 已配置 Redis Step 鎖
- **WHEN** 取得鎖的 Redis 操作擲出例外
- **THEN** MUST 回傳 `lock_contention`，且 MUST NOT 自動改走僅有 CAS 的路徑
