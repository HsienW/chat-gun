# Tasks: add-durable-hitl-and-conversation-recovery

> 每個 Task 可獨立驗證；驗證命令沿用根 `AGENTS.md` §10。

## 1. 建立 DurableInterruptManifest 契約與持久化

- [x] 1.1 定義 `DurableInterruptManifest` domain type 與 strict runtime schema（Zod），涵蓋 `interruptId`、`kind`（confirmation/clarification）、Run/Task/Step correlation、`scopeId`、`expectedResponseSchemaRef`、`expiryAt`、`executionManifest`（`ExecutionManifestRef`）、`status`、`decisionRef`（僅 confirmation，連結 X13 `approvalId`）。
- [x] 1.2 建立 `InterruptManifestRepository`（沿用 `task-repository` 持久化風格），提供 create / find-by-interruptId / atomic consume（`waiting → resumed`）。
- [x] 1.3 為 confirmation（X13 `confirmation-graph`）與 clarification（X17）兩路徑接線寫入 manifest。
- [x] 1.4 新增 unit/contract test：schema 驗證、correlation 完整、atomic consume、缺欄位 fail-closed。

**驗證命令：**
```bash
cd backend && npm run lint && npm run test && npm run build
```

## 2. 建立 RecoverySanitizer

- [x] 2.1 定義 `SanitizeResult`（`valid`／`sanitized`／`parked`）與七類偵測：unmatched tool calls/results、incomplete tool argument fragments、orphaned thinking/content blocks、partial assistant messages、invalid legacy enum/config values、already-terminal tool results、incompatible execution manifests。
- [x] 2.2 實作結構/schema 偵測，`parked` 附 redacted diagnostics，MUST NOT 依顯示文案或模型輸出反推。
- [x] 2.3 新增 unit/contract test：七類偵測各至少一個 scenario，含「無法證明有效 → parked」。

**驗證命令：**
```bash
cd backend && npm run lint && npm run test && npm run build
```

## 3. 建立 LastExecutionPointClassifier

- [x] 3.1 定義 `LastExecutionPoint`（`not_started`／`executing`／`committed`／`unknown`／`terminal`／`waiting_user`）與分類邏輯（輸入：Task/Step、ledger、checkpoint、manifest）。
- [x] 3.2 committed/unknown 的 mutation 分類強制接 X14 `SideEffectReconciler`（`commit`／`retry`／`defer`），unknown 且無 reconciler → park。
- [x] 3.3 terminal 分類不回 running（X19 單向收斂）。
- [x] 3.4 新增 unit test：六狀態分類、reconcile routing、terminal 不收斂回 running。

**驗證命令：**
```bash
cd backend && npm run lint && npm run test && npm run build
```

## 4. 分離 cancellation reason 與 transport disconnect

- [x] 4.1 定義 `RecoveryReason`（`cancellationReason` 與 `transportDisconnect` 分欄），user_cancel／timeout／supersede／crash 以 stable enum 表示。
- [x] 4.2 接線持久化與 recovery 分類。
- [x] 4.3 新增 unit test：user cancel 與 client disconnect 分離、crash 與 timeout 分離。

**驗證命令：**
```bash
cd backend && npm run lint && npm run test && npm run build
```

## 5. 建立 CrashTerminalPolicy

- [x] 5.1 fatal corruption → 停止新 claims、flush bounded telemetry、盡力持久化 crash/recovery state、exit non-zero。
- [x] 5.2 本地 redacted diagnostics 與外部 error export 配置分離。
- [x] 5.3 新增 unit test：fatal 停止新 work、recoverable crash 持久化 state、外部 export 不含 raw 敏感內容。

**驗證命令：**
```bash
cd backend && npm run lint && npm run test && npm run build
```

## 6. 組裝 recovery 路徑並以實際 checkpoint 驗證

- [x] 6.1 建立單一 recovery composition root，依序：checkpoint + manifest 讀取 → sanitizer → classifier →（必要時）reconcile → resume。
- [x] 6.2 新增 integration test：以**實際 checkpoint**（非 mock state object）驗證 interrupt 存活、resume one-time、reconcile routing、terminal 不收斂；且 MUST 涵蓋 sanitizer 對實際 checkpoint 歷史的偵測（至少一個 scenario 產生含殘缺片段的 checkpoint 歷史，驗證 sanitizer 分類為 `sanitized` 或 `parked`）。
- [x] 6.3 bff 透傳與 frontend 承接 `needs_user`／`manual_intervention_required` 不變（沿用 X19 契約），如需新增 feature flag，附 disabled 路徑回歸。

**驗證命令：**
```bash
cd backend && npm run lint && npm run test && npm run build
cd bff && npm run build
cd frontend && npm run lint && npm run test && npm run build
```

## 7. 文件與回報

- [x] 7.1 更新 operations runbook／recovery 決策記錄（parked/manual 狀態的 operator 動作）。
- [x] 7.2 如實標記未驗證項目（live checkpoint 受限者標「未驗證」）。
