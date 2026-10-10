# Spec：harness-contract-versioning

## ADDED Requirements

### Requirement: serialized contract 有 explicit version

穩定 serialized contract（event envelope、checkpoint/resume token、side-effect/idempotency record）MUST 帶 explicit `schemaVersion`；型別/schema 的 breaking change 走 semver major。

#### Scenario: envelope 帶 version

- **GIVEN** 一個 serialized event envelope
- **WHEN** 產生或還原
- **THEN** envelope 帶 explicit `schemaVersion`
- **AND** 該 version 可被獨立檢查

### Requirement: unsupported version 採 typed failure

未知或不支援的 serialized contract version MUST 回 typed compatibility failure，保留 stable code／retry class／correlation identity，不得猜測、不得靜默、不得回退 host 執行。此 typed failure MUST 沿用既有 `RuntimeVersionSet`／`evaluateRuntimeVersionCompatibility` 的 `RUNTIME_VERSION_INCOMPATIBLE`／`RUNTIME_VERSION_UNTESTED` 語意，不得另立平行版本機制。

#### Scenario: 未知版本回 typed failure

- **GIVEN** 一個 serialized contract 的 `schemaVersion` 不被目前版本支援
- **WHEN** 還原該 contract
- **THEN** 回 typed compatibility failure
- **AND** 錯誤保留 code／retry class／correlation identity 且不含 secret

#### Scenario: 沿用既有 RuntimeVersionSet 機制

- **GIVEN** 程式庫已有 `RuntimeVersionSet`（schemaVersion／eventVersion／packageVersion／checkpointVersion）與 `evaluateRuntimeVersionCompatibility`
- **WHEN** 擴展版本相容至抽取的 serialized 家族
- **THEN** 擴展既有機制，MUST NOT 新建一套並存的 versioning
- **AND** `RUNTIME_EVENT_SCHEMA_VERSION` 作為 event envelope 的 `schemaVersion` 維持既有值語意

#### Scenario: 不靜默誤讀

- **GIVEN** 未來新增 envelope 版本
- **WHEN** 舊版 consumer 讀到新版本
- **THEN** MUST NOT 以猜測或靜默降級處理
- **AND** 回 typed failure 提示升級

### Requirement: 跨套件 error identity 保留且不洩漏 secret

error 跨越 `@gun-ai/harness-*` 與 `chat-gun` 套件邊界時，MUST 保留 stable code、retry class、cause chain policy 與 correlation identity，且 MUST NOT 洩漏 credential 或 raw secret payload。

#### Scenario: 跨邊界 error 保留 identity

- **GIVEN** 一個 failure 分類原語在 `kernel` 內、執行錯誤在 `chat-gun` 內
- **WHEN** 錯誤跨越套件邊界傳遞
- **THEN** code／retry class／correlation 保留
- **AND** secret 不進入 error payload
