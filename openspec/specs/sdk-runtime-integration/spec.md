# sdk-runtime-integration Specification

## Purpose
TBD - created by archiving change agent-tool-sdk-and-manifest. Update Purpose after archive.
## Requirements
### Requirement: 註冊時驗證於 serve traffic 前 atomically fail

manifest 註冊 MUST 在 serve traffic 前完成驗證。SDK 註冊輸出僅為經驗證的宣告；受信 runtime MUST 在 descriptor、authorization policy、execution profile、受治理 tool 與 implementation 全部可用後，才公開同一 production registry。duplicate stable ID、incompatible version、invalid schema、missing action/profile、未知 policy/class、contradictory metadata、lazy module load failure、dynamic import failure、tool initialization timeout MUST 回傳 typed registration failure，且 MUST NOT 殘留 partially available tool。

#### Scenario: invalid manifest 於 serve traffic 前 fail

- **GIVEN** 一個 manifest 內部不一致
- **WHEN** 註冊該 manifest
- **THEN** MUST 於 serve traffic 前 atomically fail
- **AND** MUST NOT 殘留 partial tool

#### Scenario: lazy module load 失敗為 typed failure

- **GIVEN** 一個 tool 的 lazy module load 失敗
- **WHEN** 註冊該 tool
- **THEN** MUST 回傳 typed registration failure
- **AND** MUST NOT 留下 partial registration

#### Scenario: 初始化逾時為 typed failure

- **GIVEN** 一個 tool 的初始化超過政策上限
- **WHEN** 註冊該 tool
- **THEN** MUST 回傳 typed timeout failure
- **AND** MUST NOT 半途放行

#### Scenario: 多 registry 組裝失敗不公開部分 tool

- **GIVEN** descriptor 已通過驗證，但受信 authorization policy 或 execution profile 無法解析
- **WHEN** staging 組裝 SDK-defined tool
- **THEN** MUST 回傳 typed registration failure
- **AND** production registry MUST 保持原本的完整集合，不得公開半成品

---

### Requirement: provider-facing description 由 canonical manifest 派生且不得削弱 canonical validation

provider-facing tool description MUST 由 canonical manifest 派生；provider-specific quirks MUST 封在 provider adapter。provider schema 的截斷或轉型 MUST NOT 削弱 canonical validation，canonical validation MUST 於 dispatch 前獨立執行。

#### Scenario: provider 描述由 manifest 派生

- **GIVEN** 一個 canonical manifest
- **WHEN** 產生 provider-facing tool description
- **THEN** MUST 由 manifest 派生
- **AND** MUST NOT 由 provider quirk 反客為主

#### Scenario: provider 截斷不削弱 canonical validation

- **GIVEN** provider schema 對 input/output 做截斷或轉型
- **WHEN** 執行 dispatch
- **THEN** canonical validation MUST 獨立於 provider schema 執行
- **AND** MUST NOT 因 provider 轉型而弱化

---

### Requirement: built-in 與 SDK-defined tool 走同一 dispatch/authz/sandbox/event/side-effect 路徑

SDK-defined tool 與 built-in tool MUST 由同一 composition root 組裝、同一 registry 供給，並走同一 X14 dispatch、X13 authorization、X25 execution-profile、X19 event 與 side-effect ledger 路徑，MUST NOT 存在 per-SDK 的獨立 dispatch 或 authorization 分歧。SDK-defined tool 的選用 `manifestVersion` provenance MUST 使用既有 structured result／audit 路徑；BFF 透傳與 frontend unknown-field 處理 MUST 通過相容性測試。

#### Scenario: 同一 dispatcher 供給

- **GIVEN** built-in 與 SDK-defined tool 皆已註冊
- **WHEN** 查詢 production registry
- **THEN** 兩者 MUST 由同一 registry 供給
- **AND** MUST 經同一 dispatcher 執行

#### Scenario: SDK-defined tool 不得繞過 authorization

- **GIVEN** 一個 SDK-defined mutation tool 未通過 authorization
- **WHEN** 執行 dispatch
- **THEN** MUST deny
- **AND** MUST NOT 經 SDK 分流繞過

#### Scenario: SDK-defined tool 不得繞過 sandbox enforcement

- **GIVEN** 一個 SDK-defined tool 需要 `isolated_process` 但無 runner
- **WHEN** 執行 dispatch
- **THEN** MUST deny（`unsupported`）
- **AND** MUST NOT 退回 host 執行

#### Scenario: manifestVersion 為 additive provenance

- **GIVEN** 一個 SDK-defined tool 與一個未使用 SDK 的 built-in tool
- **WHEN** 兩者經同一 dispatcher 執行並產生 structured result／audit evidence
- **THEN** SDK tool MUST 有可與既有 execution identity 關聯的 `manifestVersion`
- **AND** built-in tool 缺少該選用欄位仍合法，BFF／frontend MUST 能安全承接

#### Scenario: 既有 tool 以 manifest 遷移仍走同一路徑

- **GIVEN** 同一個 built-in tool 的 direct descriptor 與 SDK manifest 兩種隔離註冊情境
- **WHEN** 分別組裝並執行成功、授權拒絕、sandbox 拒絕、逾時與取消案例
- **THEN** 兩者 MUST 使用同一 production dispatcher 與受信 policy/profile 解析路徑，且每個情境 MUST 只有一份 stable ID 註冊
- **AND** structured result／audit correlation 的既有語意 MUST 相同，SDK 情境 MAY 多出 additive `manifestVersion`

#### Scenario: 跨層承接 additive manifestVersion

- **GIVEN** SDK 結果含 `manifestVersion`、legacy 結果不含該欄位，並有未來新增的未知欄位
- **WHEN** BFF 透傳並由 frontend parser／renderer 承接
- **THEN** BFF MUST 保留合法 `manifestVersion` 與 correlation identity，不得改寫取消、逾時或錯誤碼
- **AND** frontend MUST 對有／無版本與未知欄位安全降級，不得拋錯或讓 terminal state 回到 running

---

### Requirement: testkit 提供 SDK failure-interleaving helpers

`@gun-ai/harness-testkit` MUST 提供 deterministic clock/ID、authorization decision、tool outcome、stream fragment、checkpoint 與 failure injection 的 builder，至少覆蓋 timeout、cancellation、malformed arguments、duplicate delivery、authorization denial、approval wait 與 ambiguous commit。

#### Scenario: failure fixture 覆蓋七類 interleaving

- **GIVEN** SDK testkit
- **WHEN** 建立 failure fixture
- **THEN** MUST 能建立 timeout／cancellation／malformed args／duplicate delivery／authz denial／approval wait／ambiguous commit
- **AND** 皆為 deterministic 且可重現

#### Scenario: testkit 可重用於既有測試

- **GIVEN** 一組既有 backend tool 測試
- **WHEN** 保留原測試，另以 testkit fixture 新增平行配對測試
- **THEN** MUST 不刪除既有斷言或放寬 assertion
- **AND** MUST 證明 testkit fixture 可重用

#### Scenario: testkit 重用範圍可核對

- **GIVEN** testkit、backend 與 SDK 套件測試皆需重播 duplicate stable ID 與 invalid manifest schema 兩組註冊失敗
- **WHEN** testkit 自身測試與 backend 測試消費同一 testkit helper，backend 另以手建 fixture 在相同 SDK 註冊路徑執行相同輸入，而 SDK 套件測試以本套件 fixture 執行等價案例
- **THEN** MUST 保留全部既有 backend 斷言，並使 backend 的手建／testkit fixture 的 typed failure code、identity 與 registry snapshot 逐欄相等；duplicate stable ID 不得覆蓋原註冊，invalid manifest schema 不得留下 partial registry
- **AND** SDK 本套件案例 MUST 以相同輸入與預期 typed failure code、identity、registry snapshot 驗證等價語意，且 SDK MUST NOT 建立對 testkit 的反向依賴

