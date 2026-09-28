# Design: add-durable-hitl-and-conversation-recovery

## 責任邊界

### backend（Runtime 權威）
- 建立並持久化 `DurableInterruptManifest`（confirmation 與 clarification 統一）。
- 以 LangGraph native `interrupt()`／checkpoint（X11）為 checkpoint/等待權威，manifest 只補充「等待/recovery 語意」。
- 於 resume 前執行 `RecoverySanitizer` 與 `LastExecutionPointClassifier`。
- committed/unknown mutation 一律接 X14 `SideEffectReconciler`。
- 執行 `CrashTerminalPolicy`。

### bff（transport 邊界）
- 透傳 interrupt/resume 事件 bytes，不做語意改寫，保留 chunk 順序、backpressure、abort（沿用 X19 BFF 透傳契約）。
- resume request 重新驗證 trusted identity 並覆寫 canonical trusted headers（沿用 X13）。

### frontend（呈現）
- 承接 `needs_user`／`manual_intervention_required` 可復原狀態與 resume 流程；不做後端語意推斷。
- 不持有 interrupt 權威狀態，只依事件還原。

## 資料流

```text
Graph node 判定 require_confirmation / clarification
  → 產生 serialized interrupt()
  → 持久化 DurableInterruptManifest（waiting_user）
  → 事件 delivery（needs_user / clarification_requested）

process 終止 → 重啟 recovery：

1. 讀 checkpoint + durable manifest（權威：LangGraph checkpoint）
2. RecoverySanitizer 驗證持久化歷史 protocol-validity
   ├─ valid     → 續
   ├─ sanitized → 以安全修正續（僅結構性刪除殘缺片段）
   └─ parked    → manual_intervention_required + diagnostics（不 invent message）
3. LastExecutionPointClassifier 分類
   ├─ not_started / executing / waiting_user → 依 manifest resume 或續跑
   ├─ committed / unknown（mutation）       → X14 SideEffectReconciler → commit / retry / defer
   └─ terminal                               → 不回 running（X19 單向收斂）
4. resume payload 驗證（scoped + one-time consume）→ 回到預期 waiting Task
5. 事件依 X19 envelope 交付，terminal 不回 running
```

## 核心元件

### 1. DurableInterruptManifest

```typescript
type InterruptKind = "confirmation" | "clarification";

interface DurableInterruptManifest {
  interruptId: string;          // 穩定、server-side 產生（correlation，非 bearer）
  kind: InterruptKind;
  runId: string;
  threadId: string;
  taskId: string;
  stepId?: string;
  scopeId: string;              // authorization scope
  expectedResponseSchemaRef: string; // 回應 schema 的版本化 reference
  expiryAt: string;             // ISO
  executionManifest: ExecutionManifestRef; // resume compatibility
  status: "waiting" | "resumed" | "expired" | "superseded" | "rejected";
  decisionRef?: {               // 僅 kind = "confirmation"；連結 X13 既有決策，不另造 token
    decisionId: string;
    approvalId: string;
  };
  createdAt: string;
  updatedAt: string;
}
```

- 單一來源：`interrupt-manifest-repository.ts`（沿用既有 `task-repository`／`step-repository` 的持久化風格，不建立第二個 Run store）。
- 權威：LangGraph checkpoint 仍是 interrupt/resume 的執行權威；manifest 提供「等待語意 + recovery 掃描入口」。
- 消費：resume 時依 `interruptId` 定位，驗證 `scopeId`／`runId`／`taskId` 一致，atomic consume（`waiting → resumed`）。

#### 一次性憑證與 X13 `approvalId` 對齊（MAJ-01）

X13 已定義 confirmation resume 的一次性憑證為 `approvalId`（MUST NOT 為單獨 bearer credential）。為避免雙 token，X20 **不引入** `resumeToken`：

- `kind = "confirmation"`：一次性憑證即 X13 `approvalId`（單一來源、單一消費），manifest 以 `decisionRef` 連結該決策；resume 驗證以 X13 decision store 的 atomic consume 為權威，manifest 只做 correlation 對齊。
- `kind = "clarification"`：無 X13 決策；一次性消費由 manifest `status` 的 atomic transition（`waiting → resumed`）強制，`interruptId` 為 correlation（對齊 X17 `clarification_resume` 的 `interruptId`），不另造 token。

兩類的「是否已消費」都由**單一 durable source**（confirmation → decision store；clarification → manifest status）決定，不存在兩套並存的一次性憑證。

#### ExecutionManifestRef 結構（MAJ-02）

```typescript
interface ExecutionManifestRef {
  manifestVersion: string;      // manifest 格式本身的 semver
  graphId: string;              // LangGraph graph id
  graphConfigHash: string;      // nodes/edges/checkpointer 配置 hash
  deploymentVersion?: string;   // release/build 識別
  schemaVersions: {
    runtimeEventEnvelope: string; // X19
    toolDescriptor: string;       // X14
    authorizationPolicy: string;  // X13
    normalizedInput: string;      // X17
  };
}
```

相容性判斷（sanitizer 第七類偵測的判定規則）：

| 條件 | 判定 |
|---|---|
| 同 `manifestVersion` major + 同 `graphId` + 同 `graphConfigHash` | `compatible` |
| `schemaVersions` 僅 minor/patch 差異 | `migratable` |
| `manifestVersion` major 差異，或 `graphId`／`graphConfigHash` 不符 | `incompatible` |

`incompatible` MUST migrate、pin 或 park，MUST NOT blind replay。

### 2. RecoverySanitizer

```typescript
type SanitizeResult =
  | { status: "valid" }
  | { status: "sanitized"; dropped: SanitizedFragment[]; reasonCodes: string[] }
  | { status: "parked"; reasonCodes: string[]; diagnostics: RedactedDiagnostic[] };
```

偵測並處置：
- unmatched Tool calls/results（無對應結果或重複結果）
- incomplete Tool argument fragments（`X15` decode 的 `incomplete`／`invalid`）
- orphaned thinking/content blocks
- partial assistant messages
- invalid legacy enum/config values
- already-terminal Tool results（不可再續）
- incompatible execution manifests（manifest version 不相容）

原則：只做「結構/schema」偵測與安全刪除，MUST NOT 依顯示文案或模型輸出反推；無法證明有效 → `parked`。

### 3. LastExecutionPointClassifier

```typescript
type LastExecutionPoint =
  | "not_started" | "executing" | "committed"
  | "unknown" | "terminal" | "waiting_user";
```

- **權威輸入**：持久化 Task/Step 狀態、side-effect ledger、checkpoint、manifest（machine identifier）。committed/unknown 的證據在 ledger/checkpoint，MUST NOT 以 message 歷史推斷。
- committed/unknown 的 mutation 分類 → 強制經 X14 `SideEffectReconciler`（`commit`／`retry`／`defer`），unknown 且無 reconciler → park（`manual_intervention_required`）。
- terminal → 不回 running（X19 單向收斂）。

#### Sanitizer → Classifier 資料流（MAJ-03）

Sanitizer 與 Classifier 的**操作對象不同**，明確分工：

1. Sanitizer 只操作 **conversation/message/Tool 歷史**（protocol validity），輸出 `SanitizeResult`。
2. Classifier 的權威輸入是 **durable 執行狀態**（Task/Step、ledger、checkpoint、manifest），不是 message 歷史。因此 sanitizer 刪除 message 片段不會抹除 committed mutation 的證據——該證據在 ledger/checkpoint。
3. `SanitizeResult` 以兩方式傳入 classifier：
   - **gate**：`status = "parked"` → 不執行 classifier，直接 `manual_intervention_required`（不 invent message）。
   - **diagnostic**：`status = "valid"`／`"sanitized"` → classifier 以 durable 證據分類，並將 `reasonCodes` 與 `dropped` 片段 summary 作為額外輸入記錄，供 reconciliation 參考（不作為 committed/unknown 的判定來源）。

```text
checkpoint + manifest 讀取
  → RecoverySanitizer（操作 message 歷史）→ SanitizeResult
       ├─ parked    → manual_intervention_required（跳過 classifier）
       └─ valid/sanitized → LastExecutionPointClassifier（輸入：durable 狀態 + SanitizeResult 作為 gate/diagnostic）
                                ├─ not_started / executing / waiting_user → resume 或續跑
                                ├─ committed / unknown（mutation）→ X14 reconcile
                                └─ terminal → 不回 running
```

### 4. Cancellation／Terminal Reason 分離

```typescript
interface RecoveryReason {
  cancellationReason?: "user_cancel" | "timeout" | "supersede" | "crash";
  transportDisconnect?: boolean;
  crash?: { fatal: boolean; phase: LastExecutionPoint };
}
```

- 持久化於 Task/Step recovery 紀錄，recovery 依 stable reason code 分類，不依字串。

### 5. CrashTerminalPolicy

- fatal corruption → 停止新 claims、flush bounded telemetry、盡力持久化 crash/recovery state、exit non-zero。
- 本地 redacted diagnostics 與外部 error export 配置分離；外部 export 不含 raw 敏感內容。

#### fatal corruption 判定準則（MIN-01）

`fatal` 只限於「無法再安全推進」的狀態，採 stable 條件判定，MUST NOT 依錯誤字串：

- checkpoint store 不可寫入（無法持久化任何 recovery state）；
- 或 state 結構損毀且無法 deserialize（checkpoint/manifest/ledger 損毀且無 fallback）；
- 或 durable 不變量被破壞（如 terminal Run 回到 running、side-effect 重複 commit 跡象）。

#### bounded telemetry 限制（MIN-01）

- flush 最多 `N` 筆（預設 ≤ 1000，可配置）；
- flush timeout 最多 `T` ms（預設 ≤ 2000ms，可配置）；
- 超過上限或 timeout 即捨棄並以 redacted reason code 記錄，不阻塞 exit non-zero。

## 替代方案

| 方案 | 結論 |
|---|---|
| 為 recovery 建立第二個 Run store | ❌ 違反 Invariant #1，LangGraph checkpoint 已是權威 |
| 直接 replay 持久化歷史不消毒 | ❌ 會重放不安全工作與 protocol-invalid 歷史 |
| 以 transcript 推斷 side effect 是否發生 | ❌ 違反 Invariant #5，effect truth 只來自 ledger/reconciler |
| 以字串/keyword 分類 sanitize | ❌ 違反「禁止硬編碼」；採 schema/結構與 stable enum |

## 風險

| 風險 | 緩解 |
|---|---|
| manifest 與 checkpoint 語意重疊 | 明確 manifest 只補 waiting/recovery，不複製 scheduling |
| sanitizer false-positive park | 附 reason code、feature flag 可關閉、operator 可放行 |
| classifier 誤判 committed | unknown 一律 reconcile/park，不假設 committed |
| 既有 interrupt 行為回歸 | additive adapter，既有 confirmation/clarification 路徑不變 |

## 驗證策略

- deterministic unit/contract test：manifest、sanitizer 七類偵測、classifier 六狀態、crash policy、reason 分離。
- integration test：使用**實際 checkpoint**（非 mock state object）驗證 interrupt 存活、resume one-time、reconcile routing。
- live spike（視 X11 已知限制）：重啟後 interrupt 存活；無法 live 者標記「未驗證」，不假稱通過。
