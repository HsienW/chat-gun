# Tasks：consumer-identity-and-account-lifecycle

> 每個 Task 可獨立驗證；驗證命令以套件現有 script（lint／test／build）為主。T0 先建立 BFF test 基礎與 cross-layer contract fixture，後續 Task 一律引用該 fixture，避免循環依賴。未完成的驗證如實標記，不假稱通過。live 驗證（真實外部 IdP、正式 Agent Server 的 resume 邊界 identity status check）屬後續 L 證據，於回報中明確列出未驗證項。

## T0 建立 BFF test 基礎與 cross-layer contract fixture

> 前置：無。本 Task 必須最先完成，T1–T8 的測試與驗證皆引用此 fixture。

- [x] 依 `bff/AGENTS.md` §13，以 Node 內建 `node:test` + `assert` 建立 BFF 測試入口，並在 `bff/package.json` 提供穩定 `test` script 與測試目錄結構。
- [x] 建立 single-source cross-layer contract fixture：opaque ID schema（`AccountId`／`UserId`／`TenantId`／`SessionId`／`DeviceId`／`CredentialId`／`PrincipalId`）、account/session status enum、`PrincipalKind` enum、`PrincipalTypeAdapter` 對映表、trusted header 映射（七個既有 + additive `x-bff-account-id`／`x-bff-session-id`／`x-bff-device-id`／`x-bff-principal-kind`）。
- [x] 以 fixture 驗證 opaque ID 字元集／長度、status enum 未知值、`PrincipalKind` 對映與未知 `principalType` fail-closed。

驗證命令：

```bash
cd bff
npm run test
npm run build
```

## T1 建立 product identity 契約與 `PrincipalKind`（backend + 共享 schema）

> 依賴：T0（引用 cross-layer fixture）。

- [x] 新增 strict runtime schema：opaque ID、account status、session status、`PrincipalKind`（`anonymous`／`authenticated`／`service`／`operator`／`delegated`）。
- [x] 定義 `delegated` principal 的 identity 契約欄位：opaque `delegatedPrincipalId`、`parentPrincipalId`（lineage）、`delegatedCapabilitySet`（least-privilege subset 參考）；只凍結契約，不實作 delegation runtime（屬 X36）。
- [x] 新增 `PrincipalTypeAdapter`：single-source versioned 對映表（`user→authenticated`、`merchant_staff→authenticated`、`platform_staff→operator`、`service→service`），未知值 fail-closed。
- [x] 於本 Task 記錄 legacy header（`x-bff-user-id`／`x-bff-tenant-id`／`x-bff-principal-type`）deprecation 計畫：本 Change 為 additive read-only 保留；移除時機為「backend 全量升級後」的下一個 Change，屆時移除 legacy header surface。
- [x] 新增 unit test：opaque ID schema、status enum unknown、`PrincipalTypeAdapter` 對映與未知值 fail-closed、delegated 契約欄位。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/authorization/
npm run build
```

## T2 `IdentityProviderPort` 與三個 adapter（bff）

> 依賴：T0。

- [x] 定義 `IdentityProviderPort`（`providerId`、`resolveIdentity`、`refreshVerificationKeys?`）與 `ResolvedProductIdentity`／typed `IdentityError` 契約。
- [x] 實作 OIDC adapter（reference production）：以 `jose`（audited JOSE primitive）做 JWT 簽章／JWKS 驗證；signature／issuer／audience／expiry+nbf（clock skew 容忍）／revocation 驗證；provider claims 只在 adapter 內收斂，不洩漏進 kernel。
- [x] 將既有 `ApiKeyPrincipalResolver`（service-token）與 `DevelopmentPrincipalResolver` 轉為 adapter，行為不變。
- [x] 實作 single-flight、concurrency-safe 的 verification-key refresh（抗 thundering-herd）。
- [x] 新增 test：三 adapter 成功／失敗；provider claim 不洩漏；malformed claims、clock skew、revoked credential、IdP timeout 的 typed failure。

驗證命令：

```bash
cd bff
npm run build
npm run test
```

## T3 帳號／session／credential 生命週期 store 與 tombstone（bff）

> 依賴：T0、T1（引用 fixture 與 identity 契約）。

- [x] 新增 account／user／tenant（個人工作區）／session／credential store port + Postgres adapter（沿用既有 store-port 模式）。
- [x] 實作帳號狀態機（pending_verification／active／recovery_restricted／suspended／deletion_pending／deleted tombstone）與 typed transition。
- [x] 實作 tombstone 機制：最小保留欄位（opaque `accountId` hash、`deletedAt`、`tombstoneVersion`、`deletionReason`）、tombstone hit 回傳 `deleted`（非 `not_found`）、cache TTL ≥ active record TTL、late event 攜帶 tombstoned identity 依政策 reject／quarantine／redact。
- [x] 實作 session／credential 的 issuance、renewal/rotation、idle expiry、absolute expiry、per-session revocation、revoke-all、compromised containment。
- [x] 建立 versioned migration 檔（沿用既有 migration 慣例）：欄位、PK／FK、index（`accountId`／`sessionId`／`tenantId`）、unique constraint、tombstone 欄位；rollback 採 additive down migration；MUST NOT 存 raw token／credential。
- [x] 新增 test：狀態機 transition、tombstone 擋 replay／late event／cache refill、revocation 語意、expiry、migration 可套用與 rollback。

驗證命令：

```bash
cd bff
npm run build
npm run test
```

## T4 server-authoritative principal 建構與 typed identity failure（bff）

> 依賴：T0、T1、T2。

- [x] 由 `ResolvedProductIdentity` 建構 trusted `PrincipalContext` + `PrincipalKind`；roles／tenant membership／billing ownership／approval authority 一律 server 端解析。
- [x] 定義 typed identity failure taxonomy（IdP timeout、key-refresh failure、malformed claims、clock skew、revoked credential、account-store unavailable），映射 stable error code + safe message（non-leaking）。
- [x] `copyRequestHeaders` 補 additive headers：`x-bff-account-id`／`x-bff-session-id`／`x-bff-device-id`／`x-bff-principal-kind`（只由 resolver 成功結果投影，client 值不採納）。
- [x] 新增 test：client 偽造 role／tenant／identity 不影響 authority；typed failure 映射；identity 失敗不洩漏 raw token／claim。

驗證命令：

```bash
cd bff
npm run build
npm run test
```

## T5 anonymous→account 遷移 endpoint（bff）

> 依賴：T0、T3、T4。

- [x] 新增 additive route `POST /api/identity/anonymous-migrate`（不觸及既有 `/api/langgraph/*`）：auth 需同時驗證「目標 account authenticated session」與「被 claim 的 anonymous session／device credential」。
- [x] 套用既有 rate-limit 路徑並以 idempotency key 去重；versioned request/response schema，response 為 opaque 遷移結果（成功／已遷移／conflict），不洩漏其他 account 歸屬。
- [x] 實作 atomic、idempotent、resumable 的 `anonymousId → accountId` 遷移；同一 `anonymousId` 只能 claim 一次。
- [x] 新增 test：遷移不遺失歸屬、race 時第二 claimant 失敗、重複 claim 語意、resume 語意、rate-limit 與 idempotency。

驗證命令：

```bash
cd bff
npm run build
npm run test
```

## T6 `ExecutionContext` additive identity 欄位與 checkpoint 還原（backend）

> 依賴：T0、T1。

- [x] `parseTrustedPrincipal` 擴充讀取 additive identity 欄位（optional，缺時容忍）與 `principalKind`（含 legacy `principalType` 收斂）。
- [x] `ExecutionContext` 新增 optional `accountId`／`sessionId`／`deviceId`／`principalKind`（strict schema，不破壞既有 mandatory 欄位）。
- [x] 定義 checkpoint 還原語意：舊 checkpoint（缺 identity 欄位）→ identity 欄位 `undefined`；受保護 resume 缺 `accountId`／`sessionId` 且 enforcement 開啟時 fail-closed（deny），不得隱性放行；development／非受保護路徑依 explicit policy 容忍。
- [x] identity 以 opaque ID 傳播至 events／audit／checkpoint／job／usage（context 投影）；redaction 確保不落 raw credential／claim。
- [x] 新增 test：additive 欄位 round-trip、舊 producer 缺欄位容忍、**舊 checkpoint 還原**（缺 identity 欄位）在受保護 resume 下 fail-closed、redaction 不落 secret。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/execution-context/ src/runtime/
npm run build
```

## T7 `RuntimeIdentityStatusPort`、feature flag 與 migration（backend）

> 依賴：T0、T1、T3（T3 的 identity store schema 為查詢來源）。

- [x] 新增 read-only `RuntimeIdentityStatusPort`（`checkAccount`／`checkSession`）+ Postgres adapter；backend 不得直接寫 account／session store。
- [x] 於新 step 與 resume 邊界檢查 status；`suspended`／`deletion_pending`／`revoked`／`compromised` 或 unavailable 時 deny（fail-closed）。
- [x] 實作 feature flag（如 `IDENTITY_STATUS_ENFORCEMENT_ENABLED`，runtime-config／profile 單一來源、啟動驗證），check point 收斂於單一 wrapper；`false` 回退至 trusted-header snapshot 語意。
- [x] 建立 identity status 查詢的 migration（如 T3 尚未涵蓋則補齊）；index 涵蓋 `accountId`／`sessionId`。
- [x] architecture test：backend 不寫 identity store、不解析 provider claim、不以 `principalType` 字串做 authority 決策。
- [x] 新增 test：enabled／disabled 兩路徑、unavailable deny、suspended 帳號 resume 拒絕、revocation 即時生效。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/ src/platform/
npm run build
```

## T8 frontend identity 承接與 anonymous 遷移入口（frontend）

> 依賴：T0 fixture（frontend 引用 identity status/error 契約）。

- [x] 承接 typed identity failure（session expired／revoked／suspended／deletion pending），觸發 re-auth 或安全降級，不以顯示文案反推狀態。
- [x] 呈現帳號／session status；anonymous→account 遷移入口與進行中狀態。
- [x] 新增 test：identity 失敗承接、status 呈現、migration 入口互動。

驗證命令：

```bash
cd frontend
npm run lint
npm run test
npm run build
```

## T9 cross-account / cross-tenant access denial integration test

> 依賴：T4、T6、T7（需 bff 與 backend 兩入口 identity 皆就緒）。

- [x] 新增 integration test：account `A` 不得存取 account `B` 的 resource；tenant `T1` principal 不得存取 tenant `T2` resource。
- [x] 覆蓋兩個入口：經 BFF（identity boundary 解析後拒絕）與 backend（authorization 於 dispatch 前 `CROSS_TENANT_DENIED`）。
- [x] 斷言 deny 為 typed reason code 且不呼叫下游，audit 記錄 opaque identity 不落 raw credential。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/ src/platform/
cd ../bff
npm run test
```

## T10 三套件全量驗證

> 依賴：T1–T9 全數完成。

- [x] 執行 frontend／bff／backend 完整 lint／test／build。
- [x] 如實記錄 skipped／未驗證項與 live 驗證缺口（真實外部 IdP、正式 Agent Server resume 邊界 identity status check 屬 L 證據）。

驗證命令：

```bash
cd backend && npm run lint && npm run test && npm run build
cd bff && npm run build && npm run test
cd frontend && npm run lint && npm run test && npm run build
```
