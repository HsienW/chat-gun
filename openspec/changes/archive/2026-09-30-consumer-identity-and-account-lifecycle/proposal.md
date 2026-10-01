# Proposal：consumer-identity-and-account-lifecycle

## 變更摘要

把既有的 trusted identity 邊界（`PrincipalContext`／`PrincipalResolver`／canonical `x-bff-*` trusted headers）從「service-token API-key + development」的靜態對映，擴充為**產品級 consumer identity 邊界**：以單一 `IdentityProviderPort` 承接一個以上外部 IdP、把已驗證 identity claims 於 server 端對映為 trusted product principal（account／user／tenant／session／device／credential／principal 的 opaque ID 集合），並新增帳號、工作區（tenancy）、session 與 credential 的完整生命週期。瀏覽器、模型、Tool 或 adapter 輸入在任何階段都 MUST NOT 偽造 runtime authority。

本 Change 對應 `second-stage-plan-en-v5.md` 的 **X22**，是 Second Stage — Layer 8（Production Product Foundation）的第一個 Change；前置 X12（`add-canonical-execution-context`）、X13（`wire-trusted-identity-authorization-hitl`）、X20（`add-durable-hitl-and-conversation-recovery`）、X21（`enforce-runtime-production-readiness-gate`）已 archive，`ExecutionContext` 的 `principal`／`scope`、trusted-header 邊界、authorization、durable resume 已就緒。X22 在**不建立第二個 runtime、第二條 authorization 路徑、或 UI-only 的持久狀態近似**的前提下，把 identity 從「可信執行身份」升級為「可管理、可撤銷、可遷移的 consumer 帳號生命週期」。

## 問題描述

盤點確認的關鍵事實（本 Change 建立時，唯讀盤點）：

1. **BFF 只有兩種 `PrincipalResolver`，且都是靜態對映**：`bff/src/identity.ts` 的 `ApiKeyPrincipalResolver`（`x-api-key`／Bearer → `BFF_API_KEY_PRINCIPALS_JSON` 靜態 profile）與 `DevelopmentPrincipalResolver`（`anonymous`/`public`/`development`）。沒有 `IdentityProviderPort`，無法承接外部 IdP，也沒有 session／credential 生命週期。

2. **`PrincipalContext.principalType` 是業務角色而非 authority class**：現有 `principalType` 為 `user`／`merchant_staff`／`platform_staff`／`service`（`bff/src/identity.ts:5-10`、`backend/src/runtime/authorization/principal.ts:1-6`）。X22 要求的 `anonymous`／`authenticated`／`service`／`operator`／`delegated` 是 authority class，兩者是正交維度；現況把 `user` 同時用於「development anonymous principal」與「API-key consumer profile」，身份與權限語意混用。

3. **tenant 只是字串，沒有 tenancy 邊界**：`tenantId` 來自 API-key profile 或 `public` 字串，沒有帳號—工作區的 durable 關聯、沒有「每帳號一個人工作區」的建模，也沒有跨 tenant 存取在 identity 層的系統性防護（僅 authorization 層有 `CROSS_TENANT_DENIED`）。

4. **沒有 session／credential 生命週期**：沒有 `SessionId`／`DeviceId`／`CredentialId`、沒有 idle／absolute expiry、沒有 per-session revocation、revoke-all、compromised containment、token／key rotation；「撤銷」目前只能靠換 API key 或重啟，無法對新 step 與 background resume 即時生效。

5. **沒有 anonymous→account 遷移**：development 的 `anonymous` principal 沒有 durable 識別與歸屬遷移路徑，無法在不遺失／不串接 conversation、artifact、approval、usage ownership 的前提下「升級為正式帳號」。

6. **身份傳播不完整**：`ExecutionContext`（`backend/src/runtime/execution-context/execution-context.ts`）只含 `principal` 與 `scope`，沒有 opaque `accountId`／`sessionId`／`deviceId`；runtime events／audit／checkpoint／job／usage 記錄以 `principalId`／`tenantId` 為主，尚無完整 consumer identity 關聯。

7. **身份失敗未型別化**：IdP timeout、JWKS key-refresh failure、malformed claims、clock skew、revoked credential、account-store unavailable 目前沒有 typed、observable、non-leaking 的失敗分類。

綜合而言，v4 runtime 已有可信執行身份與 authorization，但**沒有 consumer 帳號、session、tenancy 生命週期**——這正是 X22 issue 所述「product-grade consumer identity boundary」與「server-authoritative identity」的缺口，也違反 AGENTS.md「不得以 Prompt／固定白名單／顯示文字反推身份」與 X22 Cross-Layer Invariant #2（Identity is server-authoritative）。

## 解決方案

以「單一 `IdentityProviderPort` + 單一 trusted principal 建構邊界 + 單一 identity status enforcement + additive 傳播」收斂，不重造 v4 authorization：

1. **建立 `IdentityProviderPort`**：BFF 的 identity boundary 定義可替換的 IdP 介面，至少承接 OIDC-style external IdP、既有 service-token API-key、development 三類 adapter；provider-specific claims（`sub`、`email`、`preferred_username` 等）MUST 只在 adapter 內收斂，MUST NOT 洩漏進 backend kernel。

2. **新增 product identity 契約**：`AccountId`／`UserId`／`TenantId`（個人工作區）／`SessionId`／`DeviceId`／`CredentialId`／`PrincipalId` 與 account status、session status，皆為 server-issued opaque ID 與 typed Enum，有單一 schema、單一來源與未知值處理。

3. **`PrincipalKind`（authority class）**：新增 `anonymous`／`authenticated`／`service`／`operator`／`delegated` 五類 authority class，作為 runtime authorization 的 canonical 維度；既有 `principalType`（業務角色）於 bounded migration window 內經單一 versioned `PrincipalTypeAdapter` 對映，不散落分支。

4. **server-authoritative principal 建構**：只有 identity boundary 能由 credentials 建構 trusted product principal；roles／entitlement／tenant membership／billing ownership／approval authority 一律 server 端自 durable record 解析；client 提供的 role／tenant／billing／approval claims MUST NOT 改變 effective authority。

5. **帳號／session／credential 生命週期**：帳號狀態機（pending verification／active／recovery restricted／suspended／deletion pending／deleted/tombstoned）；session 與 credential 的 issuance／renewal/rotation／idle+absolute expiry／per-session revocation／revoke-all／compromised containment；revocation MUST 對新 step 與 background resume 即時生效且不需 process restart。

6. **tenancy 邊界**：第一版每帳號一個人工作區（personal workspace），但仍以 durable `TenantId` 建模，保留未來多工作區；跨帳號／跨 tenant 資源存取 MUST deny（擴充既有 `CROSS_TENANT_DENIED`）。

7. **anonymous→account 遷移**：以 durable `anonymousId` 建立歸屬，migration 為 idempotent、resumable、concurrency-safe 的原子連結，MUST NOT 交叉連結不同帳號或不同 anonymous session。

8. **身份傳播**：以 opaque `accountId`／`sessionId`／`deviceId`（additive trusted headers）貫穿 runtime events、audit、checkpoint、job、usage；backend `ExecutionContext` 以 additive optional 欄位承接，不破壞既有 X12 契約。

9. **identity status enforcement（backend）**：新增 read-only `RuntimeIdentityStatusPort`，在每次新 step 與 resume 邊界檢查 account／session status；unavailable 時 fail-closed（deny），不可用推導值補齊。

10. **typed identity failure**：IdP timeout、key-refresh failure、malformed claims、clock skew、revoked credential、account-store unavailable 皆為 typed、observable、non-leaking 錯誤；token／key refresh concurrency-safe 且抗 thundering-herd。

11. **相容性 adapter**：既有 development auth 與 service-token API-key surface 經 explicit adapter 保持可用；`legacyHeaderMode` 維持；不變更任何**既有** Graph ID、**既有**公開 BFF route 語意或**既有** error-code 語意（唯一新增為 additive 的 anonymous migration route `POST /api/identity/anonymous-migrate`，不影響既有 proxy）。

## 受影響範圍

### 受影響套件

- `bff`：`IdentityProviderPort`、account／user／tenant／session／credential 生命週期管理、server-authoritative principal 建構、typed identity failure、相容性 adapter、identity 傳播 headers。
- `backend`：`PrincipalKind` 契約與 `PrincipalTypeAdapter`、`ExecutionContext` additive identity 欄位、`RuntimeIdentityStatusPort`（新 step 與 resume 邊界 enforce）、identity 傳播至 events／audit／checkpoint／job／usage。
- `frontend`：identity 失敗（session expired／revoked）承接與 re-auth、帳號／session status 呈現、anonymous→account 遷移入口（不建 org admin UI）。

### 受影響能力域

- 執行身份與授權（trusted identity、principal authority、tenancy、session/account status enforcement）。
- 資料歸屬（conversation／artifact／approval／usage ownership 的 account／tenant 關聯）。
- runtime 事件／audit／checkpoint／job／usage 的 identity 傳播。

### 既有能力原語（本 Change 接線、不重造）

- `PrincipalContext`／`parseTrustedPrincipal`／`PrincipalResolver`／canonical `x-bff-*` headers（`runtime-identity-permission-governance`、`wire-trusted-identity-authorization-hitl`）。
- `ExecutionContext`／`readExecutionContext`／`readTrustedIdentity`（`add-canonical-execution-context`，X12）。
- `ResourceRef`／`AuthorizationEngine`／`CROSS_TENANT_DENIED`（`runtime-identity-permission-governance`、`trusted-tool-authorization`）。
- durable waiting／resume／terminal contract（`add-durable-hitl-and-conversation-recovery`，X20）與 versioned event envelope（`version-runtime-event-and-terminal-contract`，X19）。

## 目標

- 所有進入 runtime 的產品請求都攜帶 server-verified principal 與 tenant／workspace identity。
- client 提供的 role／tenant／billing owner／approval claims MUST NOT 改變 effective authority。
- session revocation 對新 step 即時生效，並依政策安全中斷或約束 resume。
- anonymous→account migration 為 idempotent、recoverable，並有 concurrency test。
- account suspension 與 deletion-pending 由 web、background、adapter 三個入口 enforce。
- IdP timeout 與 key-refresh failure 產生 typed、observable、non-leaking 錯誤。
- 既有 development auth 經 explicit compatibility adapter 維持可用。
- integration test 證明 cross-account 與 cross-tenant 資源存取被拒。

## 非目標

- ❌ 不建自訂 password cryptography（優先使用已審查 IdP）。
- ❌ 不信任未驗證 signature／issuer／audience／time／revocation 的 JWT payload。
- ❌ 不把 product role 編碼為 frontend-only state。
- ❌ 不以「一個 process／一個 browser／一個 conversation」當作 tenancy 邊界。
- ❌ 不新增 organization administration UI（除非另行指定）。
- ❌ 不建立第二個 runtime 或第二條 authorization 路徑（沿用 X11–X21 執行模型）。
- ❌ 不在本 Change 完成 X23（data governance／retention／deletion）與 X25（sandbox／secret broker）——X22 只建立 identity 邊界與生命週期，並預留其後續契約接點。

## 風險

| 風險 | 緩解 |
|---|---|
| `PrincipalKind` 導入造成既有 `principalType` 契約漂移 | 以 additive `x-bff-principal-kind` + 單一 versioned `PrincipalTypeAdapter` 遷移；legacy 值經 adapter 對映，新 producer 發 canonical kind；cross-layer fixture 單一來源 |
| client 直連 Agent Server 偽造 trusted identity | 維持「Agent Server 只經 BFF」network 邊界與 `configurable_headers` 白名單；backend 只消費 canonical `x-bff-*`，identity status 仍由 server-side durable record 二次驗證 |
| session／account revocation 對 resume 不即時 | backend `RuntimeIdentityStatusPort` 於 resume 邊界重新查 durable status；unavailable 即 deny（fail-closed），不以 header snapshot 為永久授權 |
| IdP token／JWKS refresh thundering-herd | single-flight／concurrency-safe refresh 介面；以 deterministic + fault-injection test 證明 |
| anonymous migration 交叉連結或重複 claim | durable `anonymousId` + atomic one-time claim；race 時第二 claimant 失敗，不外洩歸屬 |
| identity 失敗被誤當成一般 500 | typed identity failure taxonomy，BFF 映射 stable error code + safe message，backend 分類不依錯誤字串 |
| account store 失效導致可寫入被放行 | mutation／privileged read 一律 fail-closed；僅 documented public／local-only read 可降級 |

## 回滾策略

本 Change 為 additive + adapter 型變更：`IdentityProviderPort` 的既有 `ApiKeyPrincipalResolver`／`DevelopmentPrincipalResolver` 以 adapter 形式保留，`requireAuth=false`（development）路徑不變；`x-bff-principal-kind`／`x-bff-account-id`／`x-bff-session-id`／`x-bff-device-id` 為 additive headers；`ExecutionContext` 新欄位為 optional，舊 producer 可省略且消費端容忍；identity status enforcement 以 feature flag／profile 啟用，可獨立停用回到「只信 trusted-header snapshot」的既有行為。唯一新增為 additive 的 anonymous migration route，不觸及既有 proxy。若實作驗證失敗，可逐套件 revert，不變更既有 Graph ID、既有 BFF route 語意或既有 error-code 語意，也不回退資料庫 schema 歷史。
