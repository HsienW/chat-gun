# High Availability 與災難復原 Runbook

本 runbook 適用於 `high-availability-backup-and-disaster-recovery`。所有 restore、traffic shift 與 reconciliation 都是 operator-only 動作；不得由 model、一般 tool 或公開 HTTP 請求觸發。

## 權責與共同原則

- Incident Commander 決定進入 degraded、restore、rollback 或停止放量。
- Database Operator 執行 Postgres backup／isolated restore；不得將 dump、database URL 或 encryption key 寫入 log、event 或 model context。
- Runtime Operator 執行 reaper、projection rebuild、drain、canary 與 traffic shift。
- RTO/RPO 目標只讀取 `DEPLOYMENT_POLICY_JSON`；達標與否只採 restore drill 產出的 measured evidence。safe default 不代表已承諾或已達標。
- Redis 是 non-authoritative；遺失時由 Postgres authoritative facts 重建，不得以 Redis snapshot 覆蓋 Postgres。

## Regional 或 service dependency 損失

Decision point：`/health/readiness` 或 `/health/resume-ready` fail-closed，或 Postgres／checkpoint store 不可達。

1. 停止新 claims；保留 liveness 供診斷。
2. 若 read dependency 可用而 write dependency 降級，宣告 read-only degraded；否則撤出流量。
3. 確認 ownership heartbeat 與 generation；禁止舊 fencing token 寫入。
4. 依 `worker-recovery` classification requeue、resume、park_manual 或 reconciliation。
5. Rollback：將流量切回最近通過 canary 且 schema-compatible 的 instance。若無相容 instance，維持停流而非降級執行。
6. Escalation：dependency 超過 deployment policy 的 RTO 目標或出現資料完整性疑慮時，升級 Incident Commander + Database Owner。

## Corrupted projection

Authority：Postgres event log／side-effect ledger；projection 不是 fact。

1. 停止依賴該 projection 的 operator 決策，但不要改變 authoritative runtime 狀態。
2. 執行 on-demand projection rebuild；不要建立週期 singleton sweeper。
3. 比對 rebuild 的 run/event 數量與 checksum；失敗可重試且須留下結構化 evidence。
4. Rollback：丟棄新 projection，保留 authoritative facts。
5. Escalation：event integrity 或 ledger 缺失時進 restore/reconciliation 流程。

## Backup 與 restore

1. 使用 operator credential 執行 logical `pg_dump` runner，產出 schema version、timestamp、SHA-256 checksum 與 relation inventory。
2. 驗證 idempotency ledger、side-effect ledger、ownership 與 events 皆存在；checksum 不符立即拒絕。
3. 只還原到隔離環境，驗證 schema compatibility、event integrity 與 ledgers。
4. 未通過不得 promote，不得覆蓋 production store。
5. 通過後由 Incident Commander 核准 promote；encryption key 從外部 KMS／環境注入，不在 backup 內。
6. Rollback：停止 promote，回到上一份已驗證 backup 或原 production store。
7. Escalation：無任何 restorable artifact、實測 RPO/RTO 超標、或 ledger 無法對帳時升級 Security/Data Owner。

## Reconciliation

1. `post-effect-pre-ack` 或 `effect_unknown` 一律以原 idempotency key 查 provider state。
2. 未確認前不得 blind retry；確認 committed 則補 ledger/ack，確認未 committed 才依 retry budget 重試。
3. retry budget 到界後 park_manual/dead-letter。
4. Rollback：停止自動 recovery，保留 evidence 與 ownership generation。
5. Escalation：provider state 無法判定或出現雙重副作用時升級 Incident Commander 與業務 owner。

## Rolling deployment

以標準 operator entry 執行：

    ROLLING_DEPLOY_PLAN_JSON='{"deploymentId":"deploy-1","oldInstanceId":"old","newInstanceId":"new"}'
    ROLLING_DEPLOY_ADAPTER_MODULE='./operator/rolling-deploy-adapter.ts'
    npm run operations:rolling-deploy

`ROLLING_DEPLOY_ADAPTER_MODULE` 必須指向 workspace 內、由 operator 信任的
`.js`／`.mjs`／`.ts`／`.mts` 模組，並 export
`createRollingDeployDependencies(context)`。該 factory 必須提供
`drainOldInstance`、`checkResumeCompatibility`、`runCanary` 與
`shiftTraffic`；deployment-specific credential 只可由 adapter 自環境或 secret
store 取得，不得寫入 plan、stdout、event 或 log。CLI 會拒絕 workspace 外路徑、
symlink escape、過大／不支援的檔案以及缺少 factory 的模組。

1. 舊 instance stop new claims，執行 drain；結果需分列 completed、checkpointed、parked、reconciled、unresolved。
2. unresolved 非空時停止部署。
3. 驗證 schema/event/package/checkpoint version；unknown 或 incompatible 都不得 resume。
4. 新 instance canary 完整跑 task→step→checkpoint→resume→verify；unhealthy 不放量。
5. 只有 canary healthy 才 shift traffic；之後持續監看五層 health。
