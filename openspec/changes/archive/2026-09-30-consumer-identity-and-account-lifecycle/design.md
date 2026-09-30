# Design：consumer-identity-and-account-lifecycle

## 定位

本 Change 是**跨 bff／backend／frontend 的身份邊界升級**：核心是「一個 `IdentityProviderPort` + 一個 server-authoritative principal 建構邊界 + 一個 read-only identity status enforcement + additive identity 傳播」，把 v4 的 trusted execution identity 升級為可管理、可撤銷、可遷移的 consumer account／session／tenancy 生命週期。實作以 **additive 組裝 + adapter + feature-flag 啟用** 為主，不做破壞性遷移。

- `bff`：identity authority——`IdentityProviderPort`、account／user／tenant／session／credential 生命週期、server-authoritative principal 建構、typed identity failure、相容性 adapter、identity 傳播 headers。
- `backend`：identity enforcement——`PrincipalKind` 契約與 `PrincipalTypeAdapter`、`ExecutionContext` additive identity 欄位、`RuntimeIdentityStatusPort`（新 step／resume 邊界）、identity 傳播至 events／audit／checkpoint／job／usage。
- `frontend`：identity 失敗承接與 re-auth、帳號／session status 呈現、anonymous→account 遷移入口。

## 現況盤點（已驗證的事實）

| 事實 | 位置 | 對本設計的意義 |
|---|---|---|
| BFF 只有 `ApiKeyPrincipalResolver` 與 `DevelopmentPrincipalResolver`，無 `IdentityProviderPort` | `bff/src/identity.ts:72-137` | 新增 port，兩者轉為 adapter |
| `PrincipalContext` 七欄位，`principalType` 為業務角色 enum | `bff/src/identity.ts:5-36`、`backend/src/runtime/authorization/principal.ts:1-25` | 新增 `PrincipalKind`（authority class），legacy `principalType` 走 adapter |
| BFF canonical trusted headers 已由 `copyRequestHeaders` 寫入 | `bff/src/server.ts:431-439` | 擴充 additive identity headers，不變既有七欄位 |
| `parseTrustedPrincipal` 只讀七個 canonical headers | `backend/src/runtime/authorization/principal.ts:27-175` | 擴充讀取 additive identity 欄位（optional，缺時容忍） |
| `ExecutionContext` 只含 `principal` 與 `scope` | `backend/src/runtime/execution-context/execution-context.ts:8-21,42-58` | additive optional `accountId`／`sessionId`／`deviceId` |
| `CROSS_TENANT_DENIED` 已於 authorization 層存在 | `openspec/specs/runtime-identity-permission-governance/spec.md` | identity 層補 durable tenant membership，授權層語意不變 |
| versioned event envelope 與 durable resume 已就緒 | `openspec/specs/runtime-event-contract/spec.md`、`durable-hitl-conversation-recovery` | identity 以 opaque ID 進 context 投影，不另造事件族 |
| `legacyHeaderMode` 已控制舊 header 停用時程 | `bff/src/config.ts:258`、`bff/src/server.ts:440-446` | 沿用作為 legacy `x-bff-user-id`／`x-bff-tenant-id` 的遷移開關 |
| durable store 採 Postgres adapter 模式（`pg-audit-logger`／`decision-store`／`grant-store`） | `backend/src/runtime/audit/pg-audit-logger.ts`、`runtime/authorization/*` | identity store 沿用 store-port + Postgres adapter 模式 |

## 身份與權限契約

### `IdentityProviderPort`（bff，單一事實來源）

新增可替換的 IdP 介面，例如：

```text
IdentityProviderPort = {
  providerId: string
  resolveIdentity(req, config): Promise<IdentityResolution>
  refreshVerificationKeys?(): Promise<void>   // concurrency-safe, single-flight
}
```

`resolveIdentity` 回傳 discriminated union：

```text
IdentityResolution =
  | { ok: true;  identity: ResolvedProductIdentity }
  | { ok: false; error: TypedIdentityError }
```

`ResolvedProductIdentity` 至少含 `accountId`、`userId`、`tenantId`（個人工作區）、`sessionId`、`deviceId`、`credentialId`、`principalId`、`principalKind`、`roles`、`scopes`、`authSource`、`authenticatedAt`、`accountStatus`、`sessionStatus`。

- **adapter 收斂 provider claims**：OIDC adapter 只在自身內部把 `sub`／`email`／`email_verified`／issuer／audience／`sid` 等 claims 驗證並對映為 product ID；`IdentityProviderPort` 的輸出 MUST NOT 含任何 provider-specific claim，backend MUST NOT 見到 `sub` 或 raw JWT。
- **驗證門檻**：signature、issuer、audience、expiry／nbf（含 clock skew 容忍）、nonce（若適用）、revocation／session 有效性，缺一即 typed failure；MUST NOT 信任未驗證 JWT payload。
- **多 provider**：以 `providerId` 區分，config 選擇 adapter；新增 provider 只新增 adapter，不改 kernel。第一版內建三個 adapter：OIDC（reference production adapter）、service-token（既有 API-key）、development（既有 anonymous）。
- **OIDC 驗證實作**：優先使用 audited JOSE 原語 library（`jose`）進行 JWT 簽章驗證與 JWKS key 解析，不用自寫密碼學；若需完整 OIDC 發現／授權流程，才引入 `openid-client` 並經安全審查。無論選哪個，MUST 以 audited crypto primitive 驗證 signature／issuer／audience／time，MUST NOT 自行實作簽章或 roll-own crypto。
- **refresh concurrency**：JWKS／verification-key refresh 為 single-flight，並行請求共享一次 refresh，失敗時快取舊 key 至政策上限或 fail-closed；抗 thundering-herd。

### `PrincipalKind`（authority class）與 `PrincipalTypeAdapter`

- 新增 canonical `PrincipalKind` enum：`anonymous`／`authenticated`／`service`／`operator`／`delegated`。這是 runtime authorization 的 authority-class 維度，MUST 有單一來源 schema、未知值處理與測試。
- 既有 `principalType`（`user`／`merchant_staff`／`platform_staff`／`service`）保留為 bounded migration window 的業務角色維度，經**單一** versioned `PrincipalTypeAdapter` 對映至 `PrincipalKind`：
  - `user` → `authenticated`（role `user`）
  - `merchant_staff` → `authenticated`（role `merchant_staff`）
  - `platform_staff` → `operator`（role `platform_staff`）
  - `service` → `service`
- 對映表是 single-source domain constant，MUST NOT 散落各模組；未知 `principalType` 值 MUST fail-closed（不猜測、不靜默放行）。
- **`delegated` identity 契約（本 Change 只凍結契約，不實作 delegation runtime）**：delegated principal 的 identity 契約 MUST 以 opaque `delegatedPrincipalId` 表示，並保留 `parentPrincipalId`（lineage 參考）與 `delegatedCapabilitySet`（least-privilege capability subset 參考）欄位。delegated principal 的**建立**、lineage 追蹤與 least-privilege subset 的**計算**由 X36（controlled-multi-agent-delegation）負責；X22 只定義 authority class 與 identity 契約欄位，使 X36 的 delegated principal 能被 runtime authorization 正確建模，MUST NOT 在本 Change 實作 agent-to-agent delegation 或 capability 交集的計算邏輯。
- 傳播：canonical header 新增 additive `x-bff-principal-kind`；`x-bff-principal-type` 於 `legacyHeaderMode` 保留。新 producer 發 `principalKind`；舊 producer 只發 `principalType` 時由 backend `PrincipalTypeAdapter` 收斂。最終目標（後續 Change）是移除 legacy `principalType`，X22 只凍結對映與遷移契約。

### 帳號／session／credential 生命週期（identity authority）

帳號狀態機（typed，單向或政策允許的 transition）：

```text
pending_verification → active
active → recovery_restricted → active
active → suspended → active（人工恢復）
active → deletion_pending → deleted/tombstoned
```

- `deleted/tombstoned` 為不可復原的 tombstone；deleted identity MUST NOT 被 replay、cache refill 或 late event 靜默重建（tombstone 擋下）。
- `suspended` 與 `deletion_pending` 由 web、background、adapter 三個入口 enforce；跨 process 即時生效（依 durable record 查詢，不依 header snapshot）。
- session status：`active`／`expired`／`revoked`／`compromised`；credential 生命週期：issuance、renewal/rotation、idle expiry、absolute expiry、revocation。
- 撤銷語意：per-session revocation、revoke-all、compromised-session containment（同一 credential／device 的相關 session 一併處置）；撤銷對新 step 與 background resume 立即生效。

### Tombstone 機制（不可復原刪除）

deleted identity 不得被 replay、cache refill 或 late event 靜默重建，機制如下：

- **最小保留欄位**：tombstone record 只保留 opaque `accountId`（或其 hash）、`deletedAt`（刪除時間）、`tombstoneVersion`、`deletionReason`（分類 enum，non-PII）。MUST NOT 保留可重建身份／PII 的完整欄位。
- **與「從未存在」區分**：查詢命中 tombstone MUST 回傳明確 `deleted` 結果，MUST NOT 回傳 `not_found`（避免 call site 把「已刪除」誤當「可新建」）。
- **cache 互動**：tombstone 在 cache 層的 TTL MUST ≥ active record 的 TTL（確保 tombstone 不會先於 active record 失效而讓 stale cache 重建 identity）；cache miss 時 MUST 回源查 durable tombstone 而非重建。
- **永久性**：tombstone 不可復原；除非另立變更定義 legal hold／保留政策，否則不得以 purge 復原已刪除 identity。late event 攜帶 tombstoned identity 時 MUST 依政策 reject／quarantine／redact。

### Anonymous migration endpoint（additive route 契約）

anonymous→account 遷移以 **additive** BFF route 提供，不改變既有 proxy 語意：

- `POST /api/identity/anonymous-migrate`（additive；不觸及既有 `/api/langgraph/*`）。
- **auth**：需同時驗證「目標 account 的 authenticated session」與「要被 claim 的 anonymous session／device credential」；任一驗證失敗即 typed failure。
- **rate limit**：套用既有 BFF rate-limit 路徑，並額外以 idempotency key 去重，避免重複 claim。
- **request/response**：versioned schema，request 含 anonymous session reference 與 idempotency key；response 為 opaque 遷移結果（成功／已遷移／conflict），MUST NOT 回傳其他 account 的歸屬。
- 本 route 屬 additive，不變更既有 Graph ID 或既有 route 語意；proposal 相容性描述以此為準。

### identity status enforcement（backend）

新增 read-only `RuntimeIdentityStatusPort`，例如：

```text
RuntimeIdentityStatusPort = {
  checkAccount(accountId, principalId, tenantId): Promise<AccountStatusCheck>
  checkSession(sessionId, accountId, principalId): Promise<SessionStatusCheck>
}
```

- backend 於每個**新 step** 與 **resume** 邊界查詢 status；`suspended`／`deletion_pending`／`revoked`／`compromised` 或查詢 unavailable 時 fail-closed（deny），MUST NOT 以推導值補齊。
- 只讀 port，寫入僅在 identity authority；backend MUST NOT 直接寫 account／session store。
- **feature flag**：以 config key（如 `IDENTITY_STATUS_ENFORCEMENT_ENABLED`，經 runtime-config／profile 單一來源，啟動時驗證）控制；`true` 時於新 step 與 resume 邊界執行 status 查詢，`false` 時回退至「只信 trusted-header snapshot」的既有行為。check point 收斂於單一 wrapper（非散落各 node），停用路徑 MUST 有回歸測試；啟用／停用切換不得造成既有可觀察語意以外的行為變化。BFF 側若由同一 flag 控制身份失敗映射，需在 config 層單一來源並同步測試。

### identity 傳播（additive）

- BFF 新增 additive trusted headers：`x-bff-account-id`、`x-bff-session-id`、`x-bff-device-id`（皆 opaque server-issued ID）；`x-bff-principal-kind` 傳 canonical authority class。
- backend `ExecutionContext` 新增 optional `accountId`／`sessionId`／`deviceId` 與 `principalKind`；舊 producer 省略時消費端容忍（bounded migration），新 producer MUST 發送。
- **checkpoint 還原語意（backward compatible）**：新 code 還原「X22 之前、缺 identity 欄位」的舊 checkpoint 時，identity 欄位為 `undefined`；identity-dependent 行為 MUST 明確降級——identity status enforcement 開啟時，受保護 resume 缺 `accountId`／`sessionId` MUST fail-closed（deny），不得因欄位缺失而隱性放行；development ／非受保護路徑依 explicit policy 容忍。不得以空字串或推導值補齊 identity。
- events／audit／checkpoint／job／usage 以 opaque ID（`accountId`／`tenantId`／`principalId`／`sessionId`）記錄；MUST NOT 存 raw credential、token、provider claim 或 unmasked PII。

### anonymous→account 遷移（identity authority）

- anonymous principal 具 durable `anonymousId`（與 `principalId` 分離），其 conversation／artifact／approval／usage 皆以 `anonymousId` 標記歸屬。
- migration 為 atomic、idempotent、resumable 的 `anonymousId → accountId` 連結；同一 `anonymousId` 只能被一個 account claim 一次，race 時第二 claimant 失敗（不建立交叉連結）。
- 遷移不遺失、不交叉連結既有歸屬；usage ownership 由 `anonymousId` 重指到 `accountId` 為 additive 記錄，不改寫歷史 facts。

## 分層設計

### bff

1. 新增 `IdentityProviderPort` 與三個 adapter（OIDC／service-token／development），由 config 選擇；`ApiKeyPrincipalResolver`／`DevelopmentPrincipalResolver` 轉為 adapter，保持既有行為。
2. 新增 product identity 契約 schema（`AccountId`／`UserId`／`TenantId`／`SessionId`／`DeviceId`／`CredentialId`／`PrincipalId`、account status、session status、`PrincipalKind`），strict runtime validation，單一來源。
3. 新增 account／user／tenant／session／credential store port + Postgres adapter；session／credential 的 issuance、renewal/rotation、expiry、revocation、compromised containment。
4. 新增 typed identity failure taxonomy（IdP timeout、key-refresh failure、malformed claims、clock skew、revoked credential、account-store unavailable），BFF 映射 stable error code + safe message，non-leaking。
5. `copyRequestHeaders` 補 additive identity headers（`x-bff-account-id`／`x-bff-session-id`／`x-bff-device-id`／`x-bff-principal-kind`），只由 resolver 成功結果投影，client 值不採納。
6. anonymous→account migration endpoint（bounded、idempotent、resumable），並以 test 證明 race 與重複 claim 語意。

### backend

1. 新增 `PrincipalKind` enum 與 `PrincipalTypeAdapter`（single-source 對映 + unknown fail-closed）。
2. `parseTrustedPrincipal` 擴充讀取 additive identity 欄位（optional，缺時容忍）與 `principalKind`（含 legacy `principalType` 收斂）。
3. `ExecutionContext` 新增 optional `accountId`／`sessionId`／`deviceId`／`principalKind`，strict schema，不破壞既有 mandatory 欄位。
4. 新增 `RuntimeIdentityStatusPort`（read-only）與 Postgres adapter，於新 step 與 resume 邊界 enforce；unavailable fail-closed。
5. identity 以 opaque ID 傳播至 events／audit／checkpoint／job／usage（context 投影），redaction 確保不落 raw credential／claim。
6. architecture test：backend 不得直接寫 account／session store；不得解析 provider claim；不得以 `principalType` 字串做 authority 決策。

### 資料庫 migration

新增的 account／user／tenant／session／credential 與 identity status 查詢皆為 Postgres-backed：

- 沿用既有 migration 慣例（`pg-audit-logger`／`decision-store`／`grant-store` 的 schema 建立方式）；若既有慣例為獨立 migration 檔，則以同一目錄／命名規範新增 versioned migration，並記錄 rollback 策略。
- 每個新 table 於設計階段列出：欄位、PK、FK、index（含 `accountId`／`sessionId`／`tenantId` 查詢索引）、unique constraint、tombstone 欄位、timestamps；opaque ID 以 fixed-width / hashed 形式儲存，MUST NOT 存 raw token／credential／provider claim。
- migration 為 additive（新建 table／欄位），不 drop 既有 table；rollback 採 forward-fix 或 additive down migration，不破壞既有 schema 歷史。

### frontend

1. 承接 typed identity failure（session expired／revoked／account suspended／deletion pending），觸發 re-auth 或安全降級，不以顯示文案反推狀態。
2. 呈現帳號／session status；anonymous→account 遷移入口與進行中狀態。
3. 不建 org admin UI；role／tenant／approval authority 一律由後端契約驅動，不放入 frontend-only state。

## 相容性設計

1. **既有 trusted headers**：七個 `x-bff-*` principal 欄位語意不變；新增 identity headers 為 additive。
2. **既有 error-code 語意不變**：新增 typed identity error code 為 additive，不改變既有 `denied_by_authorization`／`TOOL_DISABLED_BY_POLICY` 等語意。
3. **development 相容**：`requireAuth=false` 的 `DevelopmentPrincipalResolver` 行為不變；identity status enforcement 以 explicit profile 啟用。
4. **`legacyHeaderMode`**：沿用既有開關，控制 `x-bff-user-id`／`x-bff-tenant-id` 與 `x-bff-principal-type` 的停用時程；identity 傳播的 additive headers 不受其影響。
5. **不變更既有 Graph ID／既有 BFF route 語意**：anonymous migration 以 additive route `POST /api/identity/anonymous-migrate` 提供（見「Anonymous migration endpoint」節），不觸及既有 `/api/langgraph/*` proxy；既有 route 語意、Graph ID 與 error-code 語意不變。
6. **claim versioning**：durable record 中的 identity claims 以 version 標記，未來 provider 變更不使舊 checkpoint 失效。

## 資料流

```text
Browser／adapter → BFF IdentityProviderPort
  → OIDC/service-token/development adapter 驗證 credentials（signature/issuer/audience/time/revocation）
  → server-side 對映為 ResolvedProductIdentity（opaque account/user/tenant/session/device/credential/principal + PrincipalKind + status）
  → 查詢 account/session status（suspended/deletion_pending → deny，fail-closed）
  → strip client identity，覆寫 canonical + additive trusted headers
  → LangGraph Agent Server（configurable_headers 白名單放行 trusted x-bff-*）
  → backend readExecutionContext（解析 principal/scope + additive identity）
  → 新 step／resume 邊界 RuntimeIdentityStatusPort 二次驗證（unavailable → deny）
  → authorization（沿用 X13）→ dispatch
  → events/audit/checkpoint/job/usage 記錄 opaque identity ID
```

## 替代方案與取捨

| 方案 | 說明 | 取捨 |
|---|---|---|
| 沿用 API-key／development 靜態對映（現況） | 零成本 | 無帳號／session／tenancy 生命週期，違反 X22 目標，不採用 |
| 直接擴充 `principalType` enum 加五值 | 少一個維度 | 把業務角色與 authority class 混在單一 enum，造成 `service` 雙義與 migration 混亂，不採用 |
| 新增 `PrincipalKind` + adapter（本方案） | 權限維度正交、additive 遷移 | 需新增 header 與 adapter；以 cross-layer fixture 守護 |
| backend 直接寫 account/session store | 少一個 port | 違反單一 authority，backend 越權，不採用 |
| identity status 只在 BFF 檢查 | 少 backend 依賴 | background resume／adapter 入口無法 enforce，不滿足 X22 acceptance |
| read-only `RuntimeIdentityStatusPort`（本方案） | resume 邊界 enforce、fail-closed | 需跨層 read-only port；以 fault-injection test 證明 |

## 風險與緩解

- **`PrincipalKind` 契約漂移**：additive header + 單一 `PrincipalTypeAdapter` + cross-layer fixture；legacy 值 fail-closed。
- **直連偽造**：維持 network 邊界與白名單；backend 只消費 canonical headers，且 status 由 durable record 二次驗證。
- **revocation 不即時**：`RuntimeIdentityStatusPort` 於 resume 邊界重新查詢；unavailable deny。
- **thundering-herd**：single-flight key refresh + fault-injection test。
- **anonymous 交叉連結**：atomic one-time claim + race test。
- **identity 失敗混為 500**：typed taxonomy，BFF 映射，backend 分類不依錯誤字串。
- **store 失效放行寫入**：mutation／privileged read fail-closed；僅 documented public read 降級。

> **基於未驗證假設（沿用 X11 約束）**：session／account status 於 resume 邊界的即時查詢依賴「Agent Server interrupt 後 resume 會重建同一 checkpoint 脈絡且可再次執行 identity status check」。此為 D／V 支持但**尚未取得 L（正式部署）證據**的假設；本 Change 以 deterministic + mock integration 證明契約，live 驗證另列於 tasks，不宣稱正式部署已證實。
