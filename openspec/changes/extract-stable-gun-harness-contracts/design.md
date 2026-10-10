# Design：extract-stable-gun-harness-contracts

> **ADM promotion note**
>
> 本 design 的核心決策（契約分類五類、三套件邊界與依賴方向、公開 API 治理、semver/版本政策、chat-gun adapter 消費）將在 change 完成 implementation、OpenSpec strict validation（`openspec validate extract-stable-gun-harness-contracts --strict`）通過，且 `gun-harness` repo 的三個 `@gun-ai/harness-*` 套件各發布 public `0.1.0-alpha.1`、`chat-gun` 以精確 registry 版本消費，並從包含實作與本 OpenSpec change 的已提交本地 SHA 於無 sibling checkout 的乾淨 clone 完成驗收後，promote 為 `docs/decisions/` 下的正式 ADR，主題為「gun-harness package ownership, public API, and semantic-version policy」。在上述條件完成前，本文件維持 ADM 狀態，不宣稱 extraction 已完成或 packages 已可供外部 consumer 使用。

## 1. 責任邊界

本 Change 把 X11–X21 的 runtime 從「單一套件交織」切為「stable harness contracts vs product composition」的兩 repo 分權：

- **`gun-harness` repo（獨立）**：擁有 `@gun-ai/harness-contracts`（純型別/schema）、`@gun-ai/harness-kernel`（無框架 deterministic primitives）、`@gun-ai/harness-testkit`（deterministic fixtures/failure injection 基礎）；負責套件的 CI、API-surface snapshot、clean-install、publish dry-run、provenance。不得 import React/LangChain/DB client/model SDK/chat-gun application module。
- **`chat-gun` repo（本 Change 主要）**：擁有 product composition、concrete infrastructure adapter（Postgres/Redis/MCP/LangGraph）、Provider adapter、UI、deployment 與 product policy。以 adapter 消費 `@gun-ai/harness-*`，不得保有平行本地定義。
- **`gun-harness-engineering` repo（後續，本 Change 不做）**：原則、glossary、maturity model、public theory。不在 X26 範圍。

Chat Gun 維持「one runtime, multiple surfaces」的單一權威執行路徑；抽取只是搬移型別/原語的實體位置，不新增 runtime。

## 2. 資料流與套件邊界

```text
chat-gun（product composition）
  ┌──────────────────────────────────────────────┐
  │ frontend ── bff ── backend (langgraph runtime) │
  │                       │                        │
  │        product policy / provider / UI / deployment │
  │                       │   consume via adapters │
  └───────────────────────┼────────────────────────┘
                          ▼
        @gun-ai/harness-contracts  ← @gun-ai/harness-kernel  ← @gun-ai/harness-testkit
        （9 大契約家族的型別/schema）  （deterministic primitives）  （fixtures/failure injection）
                          │
                          ▼
        gun-harness repo（npm publish；framework-neutral，無 product policy）
```

依賴方向固定：`contracts ← kernel ← testkit`，反向與跨向 product 一律禁止，由 automated boundary/cycle check 強制。

## 3. 設計決策

### 3.1 契約盤點與五類分類

對 `backend/src/runtime/` 做唯讀盤點，每個 candidate 分類到單一 owning package：

| 分類 | 歸屬 | 例（9 大契約家族） |
| --- | --- | --- |
| `stable public contract` | `@gun-ai/harness-contracts` | execution identity／`ExecutionContext`、task/step/run lifecycle、tool descriptor／invocation envelope、authorization decision/result、failure taxonomy、event envelope、checkpoint/resume token、side-effect/idempotency record、approval/terminal outcome |
| `reusable internal primitive` | `@gun-ai/harness-kernel` | `classifyError`（`retry/error-classification.ts:84-105`）、`stableEventId`（`event-sequence.ts`）、retry/backoff、idempotency key、serialized envelope validation |
| `Chat Gun product contract` | `chat-gun` | product policy、provider registry、deployment config、UI type |
| `infrastructure adapter` | `chat-gun` | Postgres/Redis/MCP/LangGraph 綁定、`persistence/*` 的 concrete client |
| `experimental` | 暫留 `chat-gun`，不 export | 未達 X11–X21 穩定語意、或只有單一 consumer 的內部型別 |

判定標準：一個型別若 (a) 有對應主 spec、(b) 語意已被 X11–X21 驗證、(c) 有外部 consumer 的合理 use case，才升為 `stable public contract`；其餘預設 private。判定表進 inventory ADR。

### 3.1.1 型別／函式三向拆分規則（解決 f1/f2/f3/f5/f7）

為避免「同一個檔混著型別、schema、runtime 函式與常數」造成歸屬不明，抽取向以**符號粒度**三向拆分，不以檔案為單位：

1. **`contracts` 只持型別／interface／Zod schema／enum（含封閉 domain constant 與閉合映射）**，零 runtime 副作用、不 import `node:*`、不含會產生值的函式（`z.parse` 是資料而非執行邏輯）。**事件 factory、id 產生、hash、解析、投影等任何 runtime 函式一律不進 `contracts`**。
2. **`kernel` 只收 deterministic、無 I/O、無框架的純函式原語**，其 `crypto`／`randomUUID`／clock 一律經注入（port/injectable），以利 testkit 提供 deterministic 實作。
3. **`chat-gun` 收 product composition**：事件 assembly、`ExecutionContext → ExecutionEventContext` 投影、BFF trusted-header 解析、concrete adapter。

據此，三個爭議檔的拆分如下：

| 檔案 | → contracts | → kernel | → chat-gun |
| --- | --- | --- | --- |
| `runtime/events.ts` | `TaskEvent`／`TaskEventType`／`TaskStatus` 等型別（於 `types.ts`） | 無（factory 不動） | `createTaskCreatedEvent` 等 event factory（呼叫 `stableEventId()`＋`executionCorrelation()`） |
| `runtime/event-sequence.ts` | 無 | `stableEventId`、`requireOpaqueId`、`RunSequenceAllocator`（注入 clock） | 無 |
| `runtime/event-envelope.ts` | `RuntimeEventSchemaVersion`／`ExecutionEventContext`／`RuntimeEventEnvelope`、`executionEventContextSchema`／`runtimeEventEnvelopeSchema`、`RUNTIME_EVENT_SCHEMA_VERSION` | `parseRuntimeEventSchemaVersion`、`parseRuntimeEventEnvelope` | `projectExecutionEventContext` |
| `runtime/execution-context/execution-context.ts` | 整檔（`ExecutionContext`＋`executionContextSchema`，只 import 型別/schema/enum） | 無 | 無 |
| `runtime/execution-context/read-execution-context.ts` | `ExecutionCorrelation` 型別 | 無 | `executionCorrelation`／`readExecutionCorrelation`／`readExecutionContext`／`readTrustedIdentity`（依賴 `parseTrustedPrincipal` product boundary） |
| `runtime/authorization/principal.ts` | `PRINCIPAL_TYPES`／`AUTH_SOURCES`／`PrincipalType`／`AuthSource`／`PrincipalContext`（型別與 enum） | 無 | `parseTrustedPrincipal`、`TRUSTED_PRINCIPAL_HEADERS`（BFF trusted-header wire format） |
| `runtime/authorization/scope.ts` | `SCOPE_TYPES`／`ScopeType`／`RuntimeScope` 等型別 | `isActiveScopePresent`／`scopeTenantMatches`／`isScopeCompatible`／`projectTrustedScope`（純 predicate/projection） | 無 |
| `runtime/authorization/consumer-identity.ts` | `opaqueIdentityIdSchema`／`principalKindSchema`／`accountStatusSchema`／`sessionStatusSchema`／`delegatedIdentitySchema`／`OPAQUE_ID_PATTERN`／`PRINCIPAL_TYPE_TO_KIND`／`principalTypeAdapter`（domain constant 閉合映射） | 無 | 無 |
| `runtime/side-effect/identity.ts` | `ReplayKey`／`ToolExecutionAttemptId`／`BusinessEffectKey`／`RequestDedupKey`（branded type）、`TrustedScope`、`ReplayIdentityInput`／`ToolExecutionAttemptIdentity`／`RequestDedupIdentityInput` | `createReplayKey`／`hashBusinessEffectKey`／`createRequestDedupKey`／`createToolExecutionAttemptIdentity`（`node:crypto` 改為注入 `hash`/`randomUUID`） | 無 |

> 此表為 T0 exhaustive inventory 的骨架；T0 產出的 decision table 以符號粒度覆蓋全 `backend/src/runtime/`，不只上表列出的檔案。

### 3.1.2 T0 符號粒度 decision table

下表是 2026-10-04 對 `backend/src/runtime/` production sources 的盤點結果。每個列出的 candidate symbol 只有一個 owner；同列的每個符號均採相同分類與 owner。沒有主 spec、X11–X21 已驗證語意或 external use case 的 export，不因目前是 TypeScript `export` 就升為 harness public API。

| 契約家族／來源 | Candidate symbols | 分類 | 單一 owner |
| --- | --- | --- | --- |
| execution identity：`execution-context/execution-context.ts` | `ExecutionContext`、`executionIdSchema`、`executionContextSchema` | `stable public contract` | `@gun-ai/harness-contracts` |
| execution identity：`execution-context/read-execution-context.ts` | `ExecutionCorrelation` | `stable public contract` | `@gun-ai/harness-contracts` |
| execution identity：`execution-context/read-execution-context.ts` | `ExecutionEnvironment`、`executionCorrelation`、`readCanonicalExecutionContext`、`readExecutionCorrelation`、`readExecutionContext`、`readDevelopmentExecutionContext`、`withExecutionContext` | `Chat Gun product contract` | `chat-gun` |
| task／step lifecycle：`types.ts` | `TASK_STATUSES`、`TaskStatus`、`STEP_STATUSES`、`StepStatus`、`StepError`、`AgentStep`、`AgentTask`、`TASK_EVENT_TYPES`、`TaskEventType`、`TaskEvent`、`TransitionResult` | `stable public contract` | `@gun-ai/harness-contracts` |
| run lifecycle：`run-status.ts` | `RUN_TERMINAL_STATUSES`、`RunTerminalStatus`、`RUN_WAITING_STATUSES`、`RunWaitingStatus`、`RunStatus`、`RunStatusTransition` | `stable public contract` | `@gun-ai/harness-contracts` |
| run lifecycle：`run-status.ts`／`state-machine.ts` | `isRunTerminalStatus`、`runStatusOf`、`runStatusReasonOf`、`transitionRunStatus`、`TASK_TRANSITIONS`、`STEP_TRANSITIONS`、`transitionTask`、`StepTransitionOptions`、`transitionStep`、`transitionTaskStep` | `Chat Gun product contract` | `chat-gun` |
| tool descriptor：`tool-dispatch/runtime-tool-descriptor.ts` | `RuntimeSchemaParseSuccess`、`RuntimeSchemaParseFailure`、`RuntimeSchema`、`TimeoutPolicy`、`ToolRateLimitPolicy`、`ToolCircuitBreakerPolicy`、`InterruptBehavior`、`RuntimeToolDescriptor`、`RuntimeToolIdentity` | `stable public contract` | `@gun-ai/harness-contracts` |
| tool invocation result：`tool-dispatch/structured-tool-result.ts` | `structuredToolResultEnvelopeSchema`、`StructuredToolResultEnvelope` | `stable public contract` | `@gun-ai/harness-contracts` |
| tool dispatch implementation | `RuntimeToolDescriptorRegistry`、`CreateStructuredToolResultInput`、`createStructuredToolResultEnvelope`、`toLegacyToolResult`、`tryToLegacyToolResult` 及 `tool-dispatch/` 其他 scheduler／pipeline／egress／secret／rate-limit implementation | `Chat Gun product contract` | `chat-gun` |
| authorization principal：`authorization/principal.ts` | `PRINCIPAL_TYPES`、`AUTH_SOURCES`、`PrincipalType`、`AuthSource`、`PrincipalContext` | `stable public contract` | `@gun-ai/harness-contracts` |
| authorization principal：`authorization/principal.ts` | `TrustedPrincipalHeaders`、`TrustedPrincipalParseResult`、`parseTrustedPrincipal` | `Chat Gun product contract` | `chat-gun` |
| authorization scope：`authorization/scope.ts` | `SCOPE_TYPES`、`ScopeType`、`RuntimeScope`、`TrustedScopeProjection`、`ProjectedTrustedScope`、`PrincipalScopeIdentity`、`StoredScopeIdentity` | `stable public contract` | `@gun-ai/harness-contracts` |
| authorization scope primitives | `isActiveScopePresent`、`scopeTenantMatches`、`projectTrustedScope`、`isScopeCompatible` | `reusable internal primitive` | `@gun-ai/harness-kernel` |
| consumer identity：`authorization/consumer-identity.ts` | `OPAQUE_ID_PATTERN`、`opaqueIdentityIdSchema`、`ACCOUNT_STATUS_VALUES`、`SESSION_STATUS_VALUES`、`PRINCIPAL_KIND_VALUES`、`accountStatusSchema`、`sessionStatusSchema`、`principalKindSchema`、`AccountStatus`、`SessionStatus`、`PrincipalKind`、`delegatedIdentitySchema`、`DelegatedIdentity`、`PRINCIPAL_TYPE_TO_KIND`、`principalTypeAdapter` | `stable public contract` | `@gun-ai/harness-contracts` |
| authorization decision：`authorization/authorization.ts` | `AUTHORIZATION_EFFECTS`、`AuthorizationEffect`、`AUTHORIZATION_REASON_CODES`、`AuthorizationReasonCode`、`AuthorizationRequest`、`AuthorizationDecision`、`ScopeAccess`、`PolicyEffect`、`AuthorizationPolicy` | `stable public contract` | `@gun-ai/harness-contracts` |
| authorization execution | `AuthorizationEvaluationInput`、`AuthorizationEngineDependencies`、`evaluateAuthorization`、`AuthorizationEngine`、authorization stores／graph／HITL bridge | `Chat Gun product contract` | `chat-gun` |
| failure taxonomy：`retry/error-classification.ts` | `ErrorCategory`、`ClassifiedError`、`ErrorClassificationContext` | `stable public contract` | `@gun-ai/harness-contracts` |
| retry contract：`retry/retry-policy.ts`／`backoff.ts`／`retry-budget.ts` | `RetryPolicy`、`BackoffOptions`、`BackoffStrategy`、`BudgetExhaustionReason`、`RetryBudget`、`BudgetCheckResult` | `stable public contract` | `@gun-ai/harness-contracts` |
| retry primitives | `classifyError`、`computeBackoff`、`createBudget`、`checkBudget`、`recordAttempt` | `reusable internal primitive` | `@gun-ai/harness-kernel` |
| retry execution | `DEFAULT_RETRY_POLICY`、`executeWithRetry` 與 concrete retry executor orchestration | `Chat Gun product contract` | `chat-gun` |
| event envelope：`event-envelope.ts`／`event-payloads.ts` | `RUNTIME_EVENT_SCHEMA_VERSION`、`RuntimeEventSchemaVersion`、`ExecutionEventContext`、`RuntimeEventEnvelope`、`executionEventContextSchema`、`runtimeEventEnvelopeSchema`、`RUNTIME_EVENT_TYPES`、`RuntimeEventType`、`JsonValue`、`RUNTIME_EVENT_PAYLOAD_SCHEMAS`、`RuntimeEventPayload` | `stable public contract` | `@gun-ai/harness-contracts` |
| event primitives：`event-envelope.ts`／`event-sequence.ts`／`event-payloads.ts` | `parseRuntimeEventSchemaVersion`、`parseRuntimeEventEnvelope`、`stableEventId`、`RunSequenceAllocatorOptions`、`RunSequenceAllocator`、`isRuntimeEventType`、`parseRuntimeEventPayload` | `reusable internal primitive` | `@gun-ai/harness-kernel` |
| event product composition | `projectExecutionEventContext`、`LEGACY_RUNTIME_EVENT_TYPE_MAP`、`createTaskCreatedEvent`、`createStepStartedEvent`、`createStepCompletedEvent`、`createStepFailedEvent`、`createStepRetryingEvent`、`createTaskCompletedEvent`、`createTaskFailedEvent`、`createTaskCancelledEvent`、`createCompensationTriggeredEvent`、`createCompensationCompletedEvent`、`createWaitingConfirmationEvent`、`createResumedEvent` | `Chat Gun product contract` | `chat-gun` |
| checkpoint／resume token：`recovery/interrupt-manifest.ts` | `INTERRUPT_MANIFEST_STATUSES`、`executionManifestRefSchema`、`durableInterruptManifestSchema`、`ExecutionManifestRef`、`DurableInterruptManifest`、`InterruptManifestStatus` | `stable public contract` | `@gun-ai/harness-contracts` |
| checkpoint／resume parsing and compatibility | `parseDurableInterruptManifest`、`RuntimeVersionSet`、`VersionCompatibility`、`evaluateRuntimeVersionCompatibility`、`assertResumeVersionCompatible` | `reusable internal primitive` | `@gun-ai/harness-kernel` |
| concrete persistence | `Queryable`、`TaskRow`、`StepRow`、`EventRow`、`mapTaskRow`、`mapStepRow`、`mapEventRow`、`Pg*Repository`、connection／migration／redaction implementation | `infrastructure adapter` | `chat-gun` |
| side-effect identity：`side-effect/identity.ts` | `ReplayKey`、`ToolExecutionAttemptId`、`BusinessEffectKey`、`RequestDedupKey`、`TrustedScope`、`ReplayIdentityInput`、`ToolExecutionAttemptIdentity`、`RequestDedupIdentityInput` | `stable public contract` | `@gun-ai/harness-contracts` |
| side-effect identity primitives | `createReplayKey`、`createToolExecutionAttemptIdentity`、`hashBusinessEffectKey`、`createRequestDedupKey` | `reusable internal primitive` | `@gun-ai/harness-kernel` |
| idempotency：`idempotency/idempotency-key.ts` | `IdempotencyKey`、`IdempotencyStatus`、`IdempotencyRecord` | `stable public contract` | `@gun-ai/harness-contracts` |
| idempotency primitives | `serializeKey`、`parseKey` | `reusable internal primitive` | `@gun-ai/harness-kernel` |
| side-effect／idempotency implementation | `SideEffectToolDescriptor` 等 execution port、`GovernedToolOutcome` 等 product outcome、ledger／runner／reconciler／result store、`IdempotencyGuard`／`PgIdempotencyGuard` | `Chat Gun product contract` 或 concrete store 時為 `infrastructure adapter` | `chat-gun` |
| approval／terminal outcome：`authorization/confirmation.ts`、`side-effect/governed-outcome.ts` | `AUTHORIZATION_CONFIRMATION_SCHEMA_VERSION`、`confirmationRequiredDescriptorSchema`、`ConfirmationRequiredDescriptor`、`confirmationResumeSchema`、`ConfirmationResume`、`confirmationInterruptPayloadSchema`、`ConfirmationInterruptPayload`、`ConfirmationConsumeFailureReason`、`ConfirmationConsumeResult`、`DispatchState`、`ToolExecutionTerminationCause`、`GovernedAuthorizationOutcome` | `stable public contract` | `@gun-ai/harness-contracts` |
| approval／terminal execution | confirmation factory／parser／store、`getToolExecutionTerminationCause`、`GovernedToolExecutor`、interaction event factories／recorders／cancel decision implementation | `Chat Gun product contract`；`Pg*` store 為 `infrastructure adapter` | `chat-gun` |

其餘 production module 已按目錄完成排除式盤點：`audit/`、`compensation/`、`data-governance/`、`input/`、`interaction/`、`lock/`、`provenance/`、`recovery/` 中未列入上表的 policy、store、repository、registry、LangGraph adapter 與 workflow 皆留 `chat-gun`；有外部 I/O 的歸 `infrastructure adapter`，純 product orchestration 歸 `Chat Gun product contract`，尚無主 spec 或 external use case 的 internal-only type 歸 `experimental` 且不得進 public snapshot。

### 3.1.3 T1 首版 surface 與 adapter 決策

- `@gun-ai/harness-contracts` 首版 public surface 就是上表 owner 為 `@gun-ai/harness-contracts` 的逐符號聯集；不使用 wildcard export。
- `@gun-ai/harness-kernel` 首版 export 限上表 owner 為 `@gun-ai/harness-kernel` 的 deterministic primitives；`node:crypto`、clock、ID generator 都由呼叫端注入。
- `@gun-ai/harness-testkit` 首版只提供 deterministic clock／ID、上述 contracts fixture builders，以及 timeout／cancellation／malformed argument／duplicate delivery／authz denial／approval wait failure injection。
- `chat-gun` adapter 以 named re-export 或 type alias 保留既有 import 語意；product factory、projection、trusted-header parsing 與 concrete store 不經 harness barrel 輸出。
- `runtime/index.ts` 的判定流程依序為：(1) symbol 是否在 contracts API snapshot；是則 named re-export，(2) 否則是否只有 chat-gun internal consumer；是則留原 owning module並加 `@internal`，(3) concrete persistence／lock／repository 一律不從 runtime public barrel 輸出，(4) 未能證明 external use case 的 symbol 預設 private。

### 3.2 三套件與依賴方向

| 套件 | 內容 | 允許依賴 |
| --- | --- | --- |
| `@gun-ai/harness-contracts` | 9 大契約家族的型別 + Zod schema，無 product/framework 依賴 | 僅 Zod v3（schema validation runtime dependency） |
| `@gun-ai/harness-kernel` | deterministic、無 I/O、無框架的 primitives | `contracts` |
| `@gun-ai/harness-testkit` | deterministic clock/ID、fixture builder、failure injection 基礎 | `contracts`、`kernel` |

- `kernel` 只收 deterministic、無 I/O、無框架原語；state-machine、tool-dispatch、authorization 的「執行邏輯」留在 `chat-gun`（只抽型別到 `contracts`），避免把 product 語意搬進 library。
- `kernel` 的 `crypto`／`randomUUID`／clock 一律經注入（`stableEventId` 的 `createEventId` 參數、`identity.ts` 的 `hash`/`randomUUID`、`RunSequenceAllocator` 的 `now`），不得直接 import `node:crypto`；`testkit` 據此提供 deterministic 實作。
- 三者都不得 import React、LangChain、Express、DB client、model SDK、chat-gun application module；由 `specs/harness-package-boundary/spec.md` 的 boundary check 強制。
- 抽出時保留作者命名與程式風格，不做機械 re-export 或 rename 模糊歷史；`chat-gun` 內以 `export { X } from "@gun-ai/harness-contracts"` 或 adapter 型別別名接線，避免一次改動全部 import。

### 3.3 兩 repo 分權與 consumption

- **Repository ownership**：`@gun-ai/harness-*` 原始碼與 CI/publish 在獨立 `gun-harness` repo；`chat-gun` 擁有 product composition。**npm distribution**：`chat-gun` 以 npm published version 消費，三套件為 public `0.1.0-alpha.1`、`alpha` dist-tag、精確套件間相依，不佔用 `latest`；實際 publish 由 Human 核准並執行。**Chat Gun Git revision**：X26 最終驗收從包含實作與本 OpenSpec change 的已提交本地 SHA 建立獨立 clone，不需 remote push；開發期 `file:`/`link:` 不構成 X26 最終交付模式。
- 本 Change 在 `chat-gun` 交付：(a) 契約 delta spec（兩 repo 的 contract of record）、(b) inventory 分類 ADM、(c) consumer-side refactor、(d) 邊界/版本/回滾強制。`gun-harness` repo 的套件實作以 delta spec 為依據，於該 repo 完成並 publish。
- 一次抽一契約家族並立即 adapt，不維持長期重複定義；`backend/src/runtime/index.ts:1-9` 的 barrel 改為 re-export `@gun-ai/harness-contracts` 的穩定符號，internal 符號不再從 barrel 輸出。
- `chat-gun` 最終依賴精確 alpha 版本並更新 lockfile；驗收從包含實作與本 OpenSpec change 的已提交本地 SHA，以 `git clone --no-local` 建立無 sibling `gun-harness` 目錄的獨立 clone，執行 `npm ci`、lint、完整 test、build 與 `npm ls`，確認依賴實際來自可匿名安裝的 npm registry package（lockfile SHA-256 對照，無本機連結、無 workspace hoisting）。

### 3.4 公開 API 治理與版本政策

- 公開符號預設不輸出：只在有 external use case 時 export，並記錄於 API-surface snapshot；公開符號有文件、有 `@since` 版本、有 deprecation 流程。三個 package 本身為 public alpha；root workspace 維持 private。
- 語意化版本（semver）：型別/schema 的 breaking change 走 major；serialized envelope 帶 explicit `schemaVersion`，未知版本 → typed compatibility failure（不得猜測、不得靜默）。
- **版本相容沿用既有機制，不新建**（解決 f4）：serialized contract 的 unknown-version typed failure 沿用既有 `backend/src/runtime/persistence/version-compatibility.ts` 的 `RuntimeVersionSet`（`schemaVersion`／`eventVersion`／`packageVersion`／`checkpointVersion`）＋ `evaluateRuntimeVersionCompatibility`（`RUNTIME_VERSION_INCOMPATIBLE`／`RUNTIME_VERSION_UNTESTED`）＋ `assertResumeVersionCompatible`。既有 `event-envelope.ts:9` 的 `RUNTIME_EVENT_SCHEMA_VERSION = "1.0.0"` 就是 event envelope 的 `schemaVersion`。T6 是把這套機制搬進 `@gun-ai/harness-kernel` 並**擴展**覆蓋所有抽取的 serialized 家族（event envelope／checkpoint/resume token／side-effect/idempotency record），而非另立一套並存。
- **barrel 穩定符號判定（解決 f6）**：`backend/src/runtime/index.ts:1-9` 的 barrel 不再 `export *` 輸出 `persistence` 等 infrastructure adapter；判定規則為「barrel re-export = `@gun-ai/harness-contracts` public API snapshot ∪ chat-gun 內部其他模組所需、但非公開契約的符號（後者以 `@internal` 標記，不出現在 API-surface snapshot）」。T1 定義並落成這條判定流程。
- 每個 X26 alpha package 帶 changelog、JS、編譯後 `.d.ts` 與 API snapshot，先通過 pack／publish dry-run；public `0.1.0-alpha.1` 已由 Human 發布（registry 可匿名取得），來源 revision 與 tarball integrity／內容對應之證據由 Codex 補齊並由 Human 追認。完整 conformance、compatibility matrix、consumer-driven release gate、provenance/signing 治理留待 X29。

### 3.5 依賴方向與邊界強制

- 新增 automated boundary/cycle check（沿用並強化 `operations/architecture-checks.ts` 的 `ARCHITECTURE_CHECK_IDS`/`CHECKS` 模式）：偵測 `@gun-ai/harness-*` 反向 import chat-gun／React／LangChain／DB client、package graph cycle，以及 `chat-gun` 保有平行本地定義。
- `harness-forbidden-dependency`、`harness-cycle`、`chat-gun-parallel-local-definition` 三條路徑 MUST 共用 `runArchitectureChecks` 的 finding、override、audit 與 fail-closed status enforcement，不得各自建立旁路 script。
- 三項 check 以 TypeScript AST 的 static import／re-export、top-level symbol declaration 與 package dependency graph 為依據，不以純 regex 哨兵當唯一防線；`.test.ts` 同時維護 production sources 與 `DELIBERATE_BYPASSES` 案例。

## 4. 替代方案與取捨

| 方案 | 取捨 | 結論 |
| --- | --- | --- |
| Monorepo `packages/`（single repo） | 迭代快、無跨 repo 協調，但未反映 plan 的 Repository Boundaries 表、publish 邊界不明 | 不採用；採獨立 repo（使用者決策） |
| 只抽純型別、kernel/testkit 全留後 | 風險最小，但無法證明「kernel 原語」可獨立，X27/X28 起點不足 | 不採用；本 Change 抽 contracts + kernel + testkit 基礎 |
| 一次性整包搬移 runtime | 快，但違反「one contract family at a time」、極易 drift | 不採用；逐家族 adapt |
| 把每個 internal type 都 export | 省分類，但鎖死未來重構、違反 private-by-default | 不採用；只 export 有 external use case 的符號 |
| 不立 contract of record，兩 repo 各自演進 | 省文件，但失去單一事實來源、易 drift | 不採用；delta spec 為 contract of record |

## 5. 安全與權限分析

- 抽取不變更 authorization 路徑；`ExecutionContext`、authorization decision、tool descriptor 的型別搬移不改語意，不新增授權面。
- 跨套件 error 只帶 stable `code`／`retryClass`／correlation identity，不得帶 credential 或 raw payload；沿用 X25 secret non-leakage 語意。
- `@gun-ai/harness-*` 不得 import product credential、provider registry 或 deployment config；boundary check 阻斷反向依賴。
- 公開 API 不得洩漏內部 topology；serialized envelope 的 unknown-version 行為 fail-closed。

## 6. 相容性

- 不變更既有 Graph ID、既有公開 BFF route 語意、既有 error-code 語意、既有 durable-state（checkpoint/event/side-effect）序列化格式。
- 型別搬移為 additive/re-export：抽取前後型別形狀相同，`chat-gun` 以 adapter 別名接線，既有 import 不改語意。
- serialized envelope 新增 `schemaVersion` 為 additive；未知版本 → typed failure，不破壞既有已發布格式。
- 回滾即還原 `chat-gun` dependency 到前一版本或前一 commit 的本地定義；durable-state 相容性由回滾 test 保證。
