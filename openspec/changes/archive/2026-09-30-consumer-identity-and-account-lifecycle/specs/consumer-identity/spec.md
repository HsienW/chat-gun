# consumer-identity Specification

## Purpose

建立產品級 consumer identity 邊界：以單一 `IdentityProviderPort` 承接外部 IdP、將已驗證 identity claims 於 server 端對映為 trusted product principal，並定義 account／user／tenant（個人工作區）／session／device／credential／principal 的 opaque 契約與帳號、session、credential 生命週期。瀏覽器、模型、Tool 或 adapter 輸入在任何階段 MUST NOT 偽造 runtime authority。

## ADDED Requirements

### Requirement: Product identity 契約為 server-issued opaque ID 與 typed status

`AccountId`／`UserId`／`TenantId`／`SessionId`／`DeviceId`／`CredentialId`／`PrincipalId` MUST 為 server-issued opaque ID（有單一字元集／長度 schema），account status 與 session status MUST 為 typed Enum（有單一來源、未知值處理與測試）。client 提供的 ID 或 status MUST NOT 具備權威性。

#### Scenario: opaque ID 通過 schema 驗證

- GIVEN 一個由 server 產生的 `accountId`／`sessionId`／`principalId` 集合
- WHEN 以 product identity schema 解析
- THEN MUST 通過並回傳 typed 值
- AND 各 ID MUST 符合字元集與長度限制

#### Scenario: 未知 account status 不被靜默放行

- GIVEN 一個未知或未來的 account status 值
- WHEN 解析或執行 authorization
- THEN MUST fail-closed（回傳明確 error）
- AND MUST NOT 以空值或推導值補齊為 `active`

#### Scenario: client 提供的 identity 不具權威性

- GIVEN client 請求攜帶自述 `userId`／`tenantId`／`accountId`／role／status
- WHEN identity boundary 解析 trusted identity
- THEN 所有 product identity 欄位 MUST 由 server 端自 durable record 導出
- AND MUST NOT 採納 client 提供的 raw identity

---

### Requirement: IdentityProviderPort 支援多 provider 且不洩漏 provider claims

BFF MUST 定義 `IdentityProviderPort`，可承接一個以上 external IdP；provider-specific claims（`sub`／`email`／`preferred_username` 等）MUST 只在 adapter 內部驗證並對映，MUST NOT 進入 runtime kernel。新增 provider MUST 只新增 adapter，不改 kernel。

#### Scenario: 多 provider 可替換

- GIVEN 已配置兩個以上 IdP adapter
- WHEN 依 `providerId` 選擇 adapter 解析 identity
- THEN MUST 回傳一致的 product identity 契約
- AND backend MUST NOT 因 provider 不同而讀到不同形狀

#### Scenario: provider claim 不洩漏至 kernel

- GIVEN OIDC adapter 解析出 `sub`／`email` 等 claims
- WHEN 產生 product identity
- THEN 輸出 MUST NOT 含 raw `sub`／`email`／raw JWT
- AND backend MUST 只消費 opaque ID 與 typed authority 欄位

#### Scenario: 未驗證 claim 被拒

- GIVEN credential 的 signature／issuer／audience／time 任一未通過驗證
- WHEN 解析 identity
- THEN MUST 回傳 typed identity failure
- AND MUST NOT 建構 trusted principal

---

### Requirement: Server-authoritative principal 建構

只有 identity boundary MUST 能由 credentials 建構 trusted product principal；runtime roles／entitlement／tenant membership／billing ownership／approval authority MUST 由 server 端 durable record 解析。client 提供的 role／tenant／billing／approval claims MUST NOT 改變 effective authority。

#### Scenario: client 偽造 role／tenant 不影響 authority

- GIVEN client 攜帶偽造 role／tenant／billing-owner／approver claim
- AND identity boundary 已配置 production resolver
- WHEN 解析 trusted principal
- THEN roles／tenant membership／billing ownership MUST 由 durable record 導出
- AND MUST NOT 採納 client 提供的 claims

#### Scenario: 模型或 tool 不得升級 principal

- GIVEN 一個模型或 tool 請求提升 principal／tenant／session
- WHEN 檢查可用 callable 路徑
- THEN MUST NOT 存在可完成該升級的路徑
- AND 該變更 MUST 僅能由 trusted external control path 觸發並分開 audit

---

### Requirement: PrincipalKind（authority class）五類明確建模

`PrincipalKind` MUST 明確區分 `anonymous`／`authenticated`／`service`／`operator`／`delegated`，並為 runtime authorization 的 canonical authority-class 維度。legacy `principalType`（業務角色）MUST 經單一 versioned adapter 對映，未知值 fail-closed。

#### Scenario: 五類 principal kind 可表示

- GIVEN 需要表達 anonymous、已認證使用者、service actor、operator 與 delegated agent
- WHEN 建構 trusted principal
- THEN 每一類 MUST 能以對應 `PrincipalKind` 表達

#### Scenario: delegated principal 契約保留 lineage 與 capability subset 欄位

- GIVEN 需要表達 delegated principal 的 identity 契約
- WHEN 定義該 identity 契約
- THEN MUST 以 opaque `delegatedPrincipalId` 表示
- AND MUST 保留 `parentPrincipalId`（lineage 參考）與 `delegatedCapabilitySet`（least-privilege capability subset 參考）欄位
- AND delegated principal 的建立、lineage 追蹤與 least-privilege 計算 MUST 由 X36（controlled-multi-agent-delegation）負責，本 Change 只凍結 identity 契約欄位，不實作 delegation runtime

#### Scenario: legacy principalType 經單一 adapter 對映

- GIVEN 既有 producer 只發 legacy `principalType`（`user`／`merchant_staff`／`platform_staff`／`service`）
- WHEN 收斂為 `PrincipalKind`
- THEN MUST 依單一 versioned 對映表收斂
- AND 對映表 MUST 有單一來源、型別、未知值處理與測試

#### Scenario: 未知 principalType fail-closed

- GIVEN 一個未知的 legacy `principalType` 值
- WHEN 收斂為 authority class
- THEN MUST fail-closed
- AND MUST NOT 猜測或靜默放行為某個 default authority

---

### Requirement: 帳號狀態機與不可復原 tombstone

帳號狀態 MUST 覆蓋 `pending_verification`／`active`／`recovery_restricted`／`suspended`／`deletion_pending`／`deleted`（tombstoned），且 transition 為 typed；`deleted` MUST 為不可復原 tombstone，deleted identity MUST NOT 被 replay、cache refill 或 late event 靜默重建。

#### Scenario: 帳號 transition 依政策有效

- GIVEN 帳號於 `active`
- WHEN 觸發 `suspended` 或 `deletion_pending`
- THEN MUST 依 typed transition 生效
- AND `deletion_pending` 帳號 MUST 由各入口 enforce

#### Scenario: deleted identity 不被靜默重建

- GIVEN 一個 `deleted`（tombstoned）帳號
- WHEN late event、replay 或 cache refill 企圖重建該 identity
- THEN tombstone MUST 擋下重建
- AND MUST NOT 讓 deleted identity 重新具備授權

---

### Requirement: Session 與 credential 生命週期與撤銷即時生效

session 與 credential MUST 支援 issuance、renewal/rotation、idle expiry、absolute expiry、per-session revocation、revoke-all 與 compromised-session containment。revocation MUST 對新 step 與 background resume 即時生效且不需 process restart。

#### Scenario: 撤銷後新 step 被拒

- GIVEN 一個 session 已 revoke
- WHEN 以該 session 發起新 step
- THEN MUST 依 durable session status 拒絕
- AND MUST NOT 因 header snapshot 或 process cache 而放行

#### Scenario: 撤銷對 resume 即時生效

- GIVEN 一個 background resume 使用已 revoke 的 session
- WHEN resume 邊界檢查 identity status
- THEN MUST 拒絕或依政策安全約束
- AND MUST NOT 以 resume 前快照為永久授權

#### Scenario: revoke-all 與 compromised containment

- GIVEN 一個 credential／device 被判定 compromised
- WHEN 執行 compromised containment
- THEN 相關 session MUST 一併撤銷
- AND revoke-all MUST 撤銷該 principal 的全部 active session

---

### Requirement: Tenancy 邊界與跨 tenant deny

第一版 MUST 以每帳號一個人工作區（personal workspace）建模 durable `TenantId`，並保留未來多工作區；跨帳號與跨 tenant 資源存取 MUST deny，且不得以 process／browser／conversation 作為 tenancy 邊界。

#### Scenario: 個人工作區與帳號一對一

- GIVEN 一個新帳號
- WHEN 建立其 tenancy
- THEN MUST 建立該帳號的個人工作區 `TenantId`
- AND 歸屬 MUST 由 durable record 表達，非以 conversation／browser 推斷

#### Scenario: 跨 tenant 存取被拒

- GIVEN principal 屬於 tenant `T1`
- AND 其嘗試存取 tenant `T2` 的 resource
- WHEN 執行 authorization
- THEN MUST 回傳 deny（`CROSS_TENANT_DENIED`）
- AND MUST NOT 呼叫下游

#### Scenario: 跨帳號存取被拒

- GIVEN account `A` 與 account `B` 分屬不同個人工作區（不同 `TenantId`）
- AND account `A` 的 principal 嘗試存取 account `B` 的 resource
- WHEN 執行 authorization
- THEN MUST 回傳 deny（`CROSS_TENANT_DENIED` 或對應 cross-account reason code）
- AND MUST NOT 呼叫下游

---

### Requirement: Anonymous 至 account 遷移為 idempotent 且不交叉連結

anonymous principal MUST 具 durable `anonymousId`；anonymous→account 遷移 MUST 為 atomic、idempotent、resumable 的連結，且 MUST NOT 交叉連結不同帳號或不同 anonymous session。

#### Scenario: 遷移連結歸屬不遺失

- GIVEN 一個 `anonymousId` 擁有多筆 conversation／artifact／approval／usage 歸屬
- WHEN 遷移至 account
- THEN 歸屬 MUST 由 `anonymousId` additive 重指至 `accountId`
- AND MUST NOT 遺失或改寫歷史 facts

#### Scenario: 同一 anonymousId 只能 claim 一次

- GIVEN 兩個 account 同時 claim 同一 `anonymousId`
- WHEN 執行遷移
- THEN 只有第一個 atomic claim 成功
- AND 第二 claimant MUST 失敗
- AND MUST NOT 建立交叉連結

---

### Requirement: Identity 以 opaque ID 貫穿 events／audit／checkpoint／job／usage

`accountId`／`tenantId`／`principalId`／`sessionId`（opaque）MUST 被傳播至 runtime events、audit、checkpoint、job 與 usage 記錄；MUST NOT 存 raw credential、token、provider claim 或 unmasked PII。

#### Scenario: opaque identity 貫穿全鏈

- GIVEN 一次 Run 從 BFF 進入並完成 model／tool／audit／event／usage
- WHEN 以 `accountId`／`runId` 查詢
- THEN MUST 能於 events、audit、checkpoint、job、usage 找到同一 opaque identity
- AND MUST NOT 存 raw credential／token／provider claim

#### Scenario: redaction 不落敏感欄位

- GIVEN identity context 可能含 raw token 或 PII
- WHEN 持久化或 log
- THEN MUST 只存 opaque ID 與 redacted summary
- AND MUST NOT 存 unmasked PII

---

### Requirement: Typed identity failure 與 fail-closed

IdP timeout、key-refresh failure、malformed claims、clock skew、revoked credential 與 account-store unavailable MUST 為 typed、observable、non-leaking 錯誤；mutation 與 privileged read 於身份無法驗證時 MUST fail-closed，僅 documented public／local-only read 可降級。

#### Scenario: IdP timeout 為 typed failure

- GIVEN IdP 驗證逾時
- WHEN 解析 identity
- THEN MUST 回傳 typed identity failure
- AND BFF MUST 映射 stable error code + safe message（non-leaking）

#### Scenario: 身份無法驗證時 mutation fail-closed

- GIVEN account store 或 session 驗證 unavailable
- WHEN 執行 mutation 或 privileged read
- THEN MUST deny（fail-closed）
- AND MUST NOT 以推導值放行

#### Scenario: key refresh 並發安全

- GIVEN 多個並發請求觸發 verification-key refresh
- WHEN refresh 進行中
- THEN MUST 以 single-flight 共享一次 refresh
- AND 失敗時依政策快取舊 key 或 fail-closed
- AND MUST NOT 造成 thundering-herd

---

### Requirement: Compatibility adapter 維持既有 auth surface

既有 development auth 與 service-token API-key surface MUST 經 explicit compatibility adapter 保持可用；`legacyHeaderMode` 控制舊 header 停用時程；本 Change MUST NOT 變更既有 Graph ID、公開 BFF route 或 error-code 語意。

#### Scenario: development auth 維持可用

- GIVEN 未配置 production resolver（development）
- WHEN 解析 context
- THEN MUST 使用隔離 development identity（`public`／`anonymous`／`development`）
- AND 既有無 `requireAuth` 行為 MUST 保持可用

#### Scenario: legacy header 停用由 flag 控制

- GIVEN 需平滑過渡既有 `x-bff-user-id`／`x-bff-tenant-id`／`x-bff-principal-type` surface
- WHEN 部署新 identity headers
- THEN 舊 header 保留 MUST 由 `legacyHeaderMode` 控制
- AND 停用時程 MUST 於 tasks 記錄 deprecation 計畫

---

### Requirement: Identity status enforcement 於新 step 與 resume 邊界

backend MUST 於每個新 step 與 resume 邊界以 read-only `RuntimeIdentityStatusPort` 檢查 account／session status；`suspended`／`deletion_pending`／`revoked`／`compromised` 或查詢 unavailable 時 fail-closed。backend MUST NOT 直接寫 account／session store。

#### Scenario: suspended 帳號於 resume 被拒

- GIVEN 一個 `suspended` 帳號的 background resume
- WHEN resume 邊界檢查 identity status
- THEN MUST 拒絕
- AND MUST NOT 直接寫 account/session store

#### Scenario: status 查詢 unavailable 時 deny

- GIVEN identity status store unavailable
- WHEN 新 step 或 resume 檢查 status
- THEN MUST deny（fail-closed）
- AND MUST NOT 以推導值補齊為 active

#### Scenario: feature flag 停用回退 snapshot 語意

- GIVEN identity status enforcement flag 停用
- WHEN 執行
- THEN MUST 回退至只信 trusted-header snapshot 的既有行為
- AND 停用路徑 MUST 有回歸測試

---

### Requirement: 跨層契約測試與三套件驗證

contract test MUST 至少覆蓋 opaque ID schema、`PrincipalKind` 對映、server-authoritative principal、帳號／session 狀態機、revocation、anonymous migration、typed identity failure、identity 傳播與 redaction；frontend、bff、backend 三套件 build／test MUST 實際執行並通過。

#### Scenario: 跨層契約測試矩陣

- GIVEN 需要驗證的 identity 契約
- WHEN 執行 contract tests
- THEN MUST 涵蓋：
  - opaque ID 與 typed status schema
  - `PrincipalKind`／`PrincipalTypeAdapter` 對映與未知值
  - client 偽造 identity 不影響 authority
  - 帳號／session 狀態機 transition 與 tombstone
  - session revocation 對新 step 與 resume 即時生效
  - anonymous migration 的 idempotency 與 race
  - IdP timeout／key-refresh／malformed claims 的 typed failure
  - identity 以 opaque ID 貫穿 events／audit／checkpoint／job／usage 且 redaction 不落 secret
  - cross-account 與 cross-tenant 資源存取拒絕的 integration test（經 BFF 與 backend 兩個入口）
- AND frontend／bff／backend 三套件 build 與 test MUST 通過
