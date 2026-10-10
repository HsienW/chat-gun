# Tasks：extract-stable-gun-harness-contracts

> 每個 Task 可獨立驗證；驗證命令以套件現有 script（lint／test／build）為主。抽取採「一次一契約家族、立即 adapt、不維持長期重複定義」。跨 repo 前置（`gun-harness` repo 建立套件並 publish alpha）於各 task 明確標示；未 publish 時不得假稱完成，只可交付契約 spec 與本地邊界檢查。T0 先完成盤點與分類，後續 Task 一律引用，避免逐檔爭論。未完成的驗證如實標記，不假稱通過。

## T0 契約盤點與分類（唯讀）

> 前置：無。本 Task 必須最先完成，T2–T9 皆引用。

- [x] 對 `backend/src/runtime/`（含 `execution-context/`、`authorization/`、`tool-dispatch/`、`side-effect/`、`idempotency/`、`retry/`、`interaction/`、`provenance/`、`persistence/`）做唯讀盤點，列出 9 大契約家族與純函數原語。
- [x] 依五類分類每個 candidate：`stable public contract`／`reusable internal primitive`／`Chat Gun product contract`／`infrastructure adapter`／`experimental`；產出 decision table（**以符號粒度**、每個符號 → owning package，非以檔案粒度）。
- [x] 依 design §3.1.1 三向拆分規則，明確拆分三個爭議檔：`authorization/principal.ts`（`parseTrustedPrincipal` 留 chat-gun）、`event-envelope.ts`（型別/schema/常數 → contracts、`parse*` → kernel、`projectExecutionEventContext` → chat-gun）、`side-effect/identity.ts`（branded type → contracts、hash 函式 → kernel，`node:crypto` 改注入）。
- [x] 判定標準寫入 design ADM：有主 spec + X11–X21 已驗證語意 + 有 external use case 才升 `stable public contract`；其餘預設 private。
- [x] 對應 `specs/harness-contract-inventory/spec.md`「單一 owning package」與「五類分類」。

驗證命令：

```bash
# 唯讀盤點，產出 decision table（進 design ADM / 後續 promote 為 ADR）
cd backend
npm run build   # 盤點不改 code，確認基線仍綠
```

## T1 契約 delta spec 定稿（contract of record）

> 前置：T0。本 Change 的 5 份 delta spec（harness-contract-inventory / harness-package-boundary / harness-public-api-surface / harness-contract-versioning / harness-consumer-integration）於 review 後定稿為兩 repo 的 contract of record。

- [x] 依 T0 盤點結果收斂 9 大契約家族在 `@gun-ai/harness-contracts` 的型別/schema 範圍與公開符號清單。
- [x] 收斂 `kernel`（error classification、stable event id、retry/backoff、idempotency key、serialized envelope validation、hash/dedup key、version-compat）與 `testkit`（deterministic clock/ID、fixture builder、failure injection）的首版範圍。
- [x] 明訂 `chat-gun` 側 adapter 別名與 re-export 策略，確保既有 import 不改語意。
- [x] 定義 barrel re-export 判定流程（解決 f6）：`runtime/index.ts` 的 barrel = `@gun-ai/harness-contracts` public API snapshot ∪ chat-gun 內部所需非公開符號（`@internal` 標記）；不再 `export *` 輸出 `persistence` 等 infrastructure adapter。
- [x] 對應 `specs/harness-package-boundary/spec.md` 與 `specs/harness-public-api-surface/spec.md` 的範圍條款。

驗證命令：

```bash
# 文件審查：delta spec 與 T0 decision table 一致、無遺漏家族
```

## T2 建立 boundary／cycle check harness

> 前置：T0。引用 `operations/architecture-checks.ts` 的 `ARCHITECTURE_CHECK_IDS`／`CHECKS` 模式。

- [x] 新增 check：`harness-forbidden-dependency`（`@gun-ai/harness-*` 反向 import chat-gun／React／LangChain／DB client／model SDK）、`harness-cycle`（contracts/kernel/testkit 之間 cycle）、`chat-gun-parallel-local-definition`（chat-gun 保有 `ExecutionContext`/`TaskStatus`/`AgentTask` 等平行本地定義）。
- [x] boundary/cycle check 以真實 import/symbol 為基礎，不以純 regex 哨兵當唯一防線；補 `.test.ts` 的 production sources 清單與 `DELIBERATE_BYPASSES` 案例。
- [x] 新增 test：forbidden dependency／cycle／parallel local definition 的 fixture 皆 fail；production sources 皆 pass。
- [x] 對應 `specs/harness-package-boundary/spec.md`「automated cycle/boundary check」。

驗證命令：

```bash
cd backend
npm run lint
npm run test -- src/operations/
npm run build
```

## T3 `@gun-ai/harness-contracts` 型別抽取與 chat-gun adapter 消費

> 前置：T1、T2。開發期先在 `gun-harness` repo 建立 `@gun-ai/harness-contracts` 並以 `link:`/`file:` 接線；最終 public alpha 發布由 T11 驗證，不以本 Task 的完成標記冒充已發布。

- [x] 於 `gun-harness` repo 建立 `@gun-ai/harness-contracts`，**只搬型別/schema/enum**：`backend/src/runtime/types.ts:1-113`（task/step/run lifecycle）、`event-envelope.ts:11-45,50-83`（`RuntimeEventSchemaVersion`/`ExecutionEventContext`/`RuntimeEventEnvelope` 型別與 schema、`RUNTIME_EVENT_SCHEMA_VERSION`）、`execution-context/execution-context.ts:13-76`（`ExecutionContext`＋`executionContextSchema`，整檔）、`authorization/` 的型別/schema/enum（`principal.ts`/`scope.ts`/`consumer-identity.ts` 的型別與 domain constant）、`side-effect/identity.ts:3-41`（branded type 與 input interface）、`retry/error-classification.ts:3-30`（`ErrorCategory`/`ClassifiedError` 型別）、`idempotency/` 型別。無 product/framework 依賴（僅 Zod v3）、不 import `node:*`。
- [x] **event factory 留 `chat-gun`**（解決 f1/f5）：`events.ts:1-103` 的 `createTaskCreatedEvent` 等 factory 呼叫 `stableEventId()`＋`executionCorrelation()`，屬 product composition，**不進 contracts**；`contracts` 只持其型別。`read-execution-context.ts` 因含 `parseTrustedPrincipal` product boundary，整檔留 `chat-gun`。
- [x] `chat-gun` 移除平行本地定義，改以 adapter 別名／re-export 消費 `@gun-ai/harness-contracts`；`backend/src/runtime/index.ts:1-9` 的 barrel 依 T1 判定流程只 re-export 穩定符號，internal 符號不再輸出。
- [x] 抽前後型別形狀相同；既有 import 不改語意；`backend` lint/test/build 全綠。
- [x] 對應 `specs/harness-consumer-integration/spec.md`「無平行本地定義」與 `specs/harness-package-boundary/spec.md`「contracts 無 product/framework 依賴（僅 Zod v3）」。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T4 `@gun-ai/harness-kernel` primitives 抽取

> 前置：T3。開發期可從 sibling checkout 接線；`@gun-ai/harness-kernel` 的 public alpha 發布由 T11 驗證。

- [x] 於 `gun-harness` repo 建立 `@gun-ai/harness-kernel`，搬移 deterministic、無 I/O、無框架原語：`classifyError`（`retry/error-classification.ts:84-105`）、`stableEventId`＋`requireOpaqueId`（`event-sequence.ts:101-114`）、`parseRuntimeEventSchemaVersion`／`parseRuntimeEventEnvelope`（`event-envelope.ts:85-127`）、`createReplayKey`／`hashBusinessEffectKey`／`createRequestDedupKey`／`createToolExecutionAttemptIdentity`（`side-effect/identity.ts:53-114`，`node:crypto` 改注入 `hash`/`randomUUID`）、`evaluateRuntimeVersionCompatibility`／`assertResumeVersionCompatible`（`persistence/version-compatibility.ts`）、`isActiveScopePresent`／`scopeTenantMatches`／`isScopeCompatible`／`projectTrustedScope`（`authorization/scope.ts:38-81`）、retry/backoff、idempotency key。依賴 `contracts`。
- [x] 所有 `crypto`／`randomUUID`／clock 經注入（`createEventId`／`now` 參數），不得直接 import `node:crypto`；`chat-gun` composition root 綁定真實實作，`testkit` 提供 deterministic 實作。
- [x] `chat-gun` 以 re-export 消費，移除平行本地定義；state-machine／tool-dispatch／authorization 的執行邏輯留在 `chat-gun`（只抽型別到 contracts）。
- [x] 新增 unit test：kernel 原語跨套件後輸出不變（以抽取前後 snapshot 對照）。
- [x] 對應 `specs/harness-package-boundary/spec.md`「kernel 只收無框架原語」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/retry/ src/runtime/
npm run build
```

## T5 `@gun-ai/harness-testkit` 基礎

> 前置：T4。開發期可從 sibling checkout 接線；`@gun-ai/harness-testkit` 的 public alpha 發布由 T11 驗證。

- [x] 於 `gun-harness` repo 建立 `@gun-ai/harness-testkit`：deterministic clock／ID、fixture builder、failure injection 基礎（timeout／cancellation／malformed argument／duplicate delivery／authz denial／approval wait 的 fixture builder）；依賴 `contracts`+`kernel`。
- [x] 以 testkit 重寫至少一組既有 backend 測試的 fixture，證明可重用（不得刪除既有斷言或放寬 assertion）。
- [x] 對應 `specs/harness-consumer-integration/spec.md`「testkit 可重用」與 `specs/harness-package-boundary/spec.md`。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
```

## T6 serialized contract versioning + unsupported-version typed failure（沿用既有機制）

> 前置：T3、T4。

- [x] **擴展既有 `version-compatibility.ts`，不新建**（解決 f4）：把 `RuntimeVersionSet`／`evaluateRuntimeVersionCompatibility`／`assertResumeVersionCompatible`（`persistence/version-compatibility.ts:1-38`）搬進 `@gun-ai/harness-kernel`，並擴展覆蓋 event envelope、checkpoint/resume token、side-effect/idempotency record；`RUNTIME_EVENT_SCHEMA_VERSION = "1.0.0"`（`event-envelope.ts:9`）進 `contracts` 作為 event envelope 的 `schemaVersion`。
- [x] unknown version → typed failure：沿用 `RUNTIME_VERSION_INCOMPATIBLE`／`RUNTIME_VERSION_UNTESTED`（不得猜測、不得靜默、不得回退 host 執行），保留 code/retry class/correlation。
- [x] 新增 test：known version pass；unknown version → typed failure；跨套件 error identity 保留 code/retry class/correlation 且無 secret。
- [x] 對應 `specs/harness-contract-versioning/spec.md`。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/event-envelope.test.ts src/runtime/
npm run build
```

## T7 公開 API surface snapshot + public export 治理

> 前置：T3、T4、T5。

- [x] 公開符號預設不輸出；只 export 有 external use case 的符號，並記錄於 API-surface snapshot（`gun-harness` repo CI）。套件本身於 X26 發布 public alpha，root workspace 維持 private。
- [x] 公開符號有文件、`@since` 版本、deprecation 流程；snapshot 變更必須走 semver 決策。
- [x] 新增 API-surface test：未預期的 export 變更 fail；chat-gun 只 import snapshot 內符號。
- [x] 對應 `specs/harness-public-api-surface/spec.md`。

驗證命令：

```bash
cd backend
npm run build
# gun-harness repo：API-surface snapshot check（clean-install + publish dry-run）
```

## T8 回滾 test（durable-state 相容）

> 前置：T3、T6。

- [x] 新增回滾 test：`chat-gun` downgrade `@gun-ai/harness-*` 到前一 version（或前一 commit 的本地定義）後，既有 checkpoint/event/side-effect 序列化資料仍可讀，durable-state 相容。
- [x] 證明抽取不變更序列化格式；serialized envelope 的 `schemaVersion` additive。
- [x] 對應 `specs/harness-consumer-integration/spec.md`「rollback 不失 durable-state 相容」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
```

## T9 ADR promotion + 文件

> 前置：T0–T8 完成後。Phase B 的 sibling `file:` package clean-build 為開發期證據；X26 最終 gate 另須完成 T10–T12 的 public alpha 發布與 portable install。完整 provenance、signing、conformance 與 compatibility matrix 留待 X29。

- [x] 於 design 的 ADM 決策段落標註「待 review 後 promote 為 `docs/decisions/` ADR」，列出 promote 時機與主題「gun-harness package ownership, public API, and semantic-version policy」。
- [x] 確認 boundary/cycle check、API-surface snapshot、publish dry-run 的運作說明已寫入文件。
- [x] 對應 X26「gun-harness package ownership, public API, and semantic-version policy」ADR 主題（文件驗證，無自動化 test）。

驗證命令：

```bash
# 文件審查：契約分類、依賴方向、版本政策、回滾計畫皆已記載
```

## T10 `@gun-ai/harness-*` public alpha 候選版準備（Codex）

> 前置：T0–T9；Human 已定案 scope=`@gun-ai`，三套件名稱與版本 `0.1.0-alpha.1`。本 Task 不執行實際 publish。

- [x] 將三套件、內部 imports、backend imports／架構檢查、OpenSpec 與文件統一改名為 `@gun-ai/harness-contracts`、`@gun-ai/harness-kernel`、`@gun-ai/harness-testkit`；不得殘留舊 npm scope。
- [x] 三套件使用精確 `0.1.0-alpha.1` 相依版本；package 公開發佈設定為 `alpha` dist-tag，root workspace 維持 private；公開型別入口指向編譯後的 `.d.ts`。
- [x] `gun-harness` clean install、build、typecheck、測試、API snapshot、三套件 `npm pack --dry-run` 與 `npm publish --dry-run` 全部通過；tarball 含 JS、`.d.ts`、changelog，不含測試或秘密；Zod 維持 v3。

驗證命令：

```bash
cd ../gun-harness
npm ci
npm run check
npm pack --dry-run --workspace @gun-ai/harness-contracts
npm pack --dry-run --workspace @gun-ai/harness-kernel
npm pack --dry-run --workspace @gun-ai/harness-testkit
npm publish --dry-run --tag alpha --workspace @gun-ai/harness-contracts
npm publish --dry-run --tag alpha --workspace @gun-ai/harness-kernel
npm publish --dry-run --tag alpha --workspace @gun-ai/harness-testkit
```

## T11 Human public alpha 發布 gate（已發布，證據核實）

> 前置：T10 驗證通過。三套件 public `0.1.0-alpha.1` 已由 Human 發布，`backend/package-lock.json` resolved 指向 registry.npmjs.org 且 `node_modules` 為實體目錄、非 link。本 Task 不重新發布同一版本，改為逐項核實發布證據；缺證者明列待 Codex／Human 補證，不得以「已發布」逕行推定全部完成。

- [x] Human 已依 `contracts` → `kernel` → `testkit` 順序發布 public `0.1.0-alpha.1`（`alpha` dist-tag，不佔用 `latest`、不覆寫既有版本）；`backend/package-lock.json` resolved 指向 registry.npmjs.org，`node_modules` 為實體目錄非 link，且無 sibling clean-clone `npm ci` 成功（見 `evidence/local-sha-clean-clone-summary.json`），證明安裝來源為 npm registry。
- [x] 唯讀核對三套件 registry 版本／dist-tag 可匿名取得，且套件間相依版本精確；以不帶憑證、不讀 npm 設定的直接 registry HTTP 請求驗證 metadata 與 tarball 均回傳 200，`alpha` 指向 `0.1.0-alpha.1`（見 `evidence/published-alpha-summary.json`）。
- [x] 核實來源 revision：從 `6d4e81d96c5e16bd88b72bfa996a9ee78ea57f62` 獨立 clone、clean install、check 後重建三套件，與公開 tarball 逐位元組相同；registry integrity 與 Chat Gun lockfile 一致，tarball SHA-256 已記錄（見 `evidence/published-alpha-summary.json`）。
- [x] Human 已於 2026-10-10 在本交接對話明確確認三套件目前已發布的公開內容與 MIT 授權；發布內容與來源修訂的技術對應另見 `evidence/published-alpha-summary.json`。

驗證命令：

```bash
npm view @gun-ai/harness-contracts@0.1.0-alpha.1 version dist-tags --registry=https://registry.npmjs.org/
npm view @gun-ai/harness-kernel@0.1.0-alpha.1 version dist-tags --registry=https://registry.npmjs.org/
npm view @gun-ai/harness-testkit@0.1.0-alpha.1 version dist-tags --registry=https://registry.npmjs.org/
# tarball integrity／來源 revision 對應核對（Codex 依 gun-harness repo 流程產出證據）
```

## T12 Chat Gun registry 消費與 portable clean-clone（Codex + Human）

> 前置：三套件 public `0.1.0-alpha.1` 實際可匿名安裝。最終驗收不得依賴 sibling `gun-harness`、repo-local staging 或 workspace hoisting。

- [x] backend 三項依賴由開發期 `file:` 改為精確 `0.1.0-alpha.1` registry 版本，更新 lockfile；`npm ls` 與實際 package 路徑證明來源為 registry package。
- [x] 在沒有 sibling `gun-harness` 目錄的隔離環境執行 `npm ci`、lint、完整 test、build、boundary／cycle／parallel-definition、API surface 與 rollback compatibility 驗證。
- [ ] 從包含本 consumer 實作（package.json／lockfile）與本 OpenSpec change（proposal／design／tasks／五份 delta specs）的已提交本地 SHA，以 `git clone --no-local` 建立獨立 clone，重跑全部驗證、OpenSpec strict 與 `git diff --check`；不要求 remote push。此 SHA 通過後，才交 Qwen 對新範圍唯讀 review-result。最後一項在新修訂驗證完成前保持未勾選。

> 驗收後若需更新 checkbox、evidence 或 archive，屬後續文件修訂；驗收證據錨定實際驗收 SHA，不要求該 SHA 預先包含自身通過證據（避免無限重提交）。若驗收後修改 executable code、依賴或實質規格，才重新評估受影響驗證。

驗證命令（backend 與 repository-root 分開標示工作目錄）：

```bash
# backend（chat-gun/backend）
cd backend
npm ci
npm run lint
npm run test
npm run build
npm ls @gun-ai/harness-contracts @gun-ai/harness-kernel @gun-ai/harness-testkit zod

# repository root（chat-gun-react-agent）
openspec validate extract-stable-gun-harness-contracts --strict
git diff --check
```
