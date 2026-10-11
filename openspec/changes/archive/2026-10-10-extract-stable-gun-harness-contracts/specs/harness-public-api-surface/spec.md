# Spec：harness-public-api-surface

## ADDED Requirements

### Requirement: 公開 export 有意且受治理

`@gun-ai/harness-*` 套件於 X26 作為 public alpha 發布，但符號預設不輸出；只有 external use case 的符號才進入公開 API。公開符號 MUST 有文件、`@since` 版本標記與 deprecation 流程，並受 API-surface snapshot 鎖定。

#### Scenario: 未預期的 export 變更被偵測

- **GIVEN** `@gun-ai/harness-contracts` 有一份 API-surface snapshot 記錄公開符號
- **WHEN** 有人新增或移除公開 export 而未更新 snapshot
- **THEN** API-surface test MUST fail
- **AND** 變更必須走 semver 決策

#### Scenario: internal 型別不被誤當公開 API

- **GIVEN** 一個型別只有 chat-gun internal consumer、無 external use case
- **WHEN** 決定 export
- **THEN** 該型別 MUST NOT 從 `@gun-ai/harness-*` 公開面輸出
- **AND** 於 chat-gun 內保留為 internal

### Requirement: 每個 internal TS 型別不必然公開

extraction MUST NOT 把每個 internal TypeScript 型別當作 public API；只有穩定、有契約語意、有 supported external use case 的符號才公開。

#### Scenario: internal-only 型別維持 private

- **GIVEN** 一個 runtime 內部實作型別未對應任何主 spec 或外部 use case
- **WHEN** 進行抽取
- **THEN** 該型別維持 private
- **AND** MUST NOT 進入 `@gun-ai/harness-*` 公開面
