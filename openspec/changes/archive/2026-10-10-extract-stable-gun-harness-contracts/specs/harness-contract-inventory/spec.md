# Spec：harness-contract-inventory

## ADDED Requirements

### Requirement: 每個 candidate contract 都歸屬單一 owning package

`chat-gun` 在抽取前 MUST 產生一份 reviewed inventory，把每個 runtime candidate contract 分類到唯一 owning repository/package，不得由多個 package 共同擁有同一契約。

#### Scenario: 契約被分類到單一 owning package

- **GIVEN** v4 runtime 內有 task/step/run lifecycle、execution identity、event envelope、failure taxonomy、side-effect/idempotency、authorization、checkpoint/resume、approval/terminal outcome 等契約家族
- **WHEN** CCR 或 Implementer 執行 inventory 盤點
- **THEN** 每個符號都被分類到唯一 owning package
- **AND** 分類結果記錄於 decision table，可追溯至對應主 spec 與 X11–X21 驗證語意

#### Scenario: 無 owning package 的契約不得抽取

- **GIVEN** 某型別尚未判定 owning package，或語意未達 X11–X21 穩定
- **WHEN** 進行抽取
- **THEN** 該型別 MUST NOT 被 export 為 public contract
- **AND** 維持 internal 或歸為 `experimental`，不進入 `@gun-ai/harness-*` 公開面

### Requirement: 契約分類採五類且預設 private

inventory 分類 MUST 使用五類：`stable public contract`、`reusable internal primitive`、`Chat Gun product contract`、`infrastructure adapter`、`experimental`。一個型別只有在同時滿足「有對應主 spec、X11–X21 已驗證語意、有外部 consumer 的合理 use case」時才升為 `stable public contract`；其餘預設 private。

#### Scenario: 只有滿足條件的型別才公開

- **GIVEN** 一個型別有主 spec 但只有單一 chat-gun internal consumer、無外部 use case
- **WHEN** 判定其公開性
- **THEN** 該型別 MUST NOT 列為 public contract
- **AND** 維持 private，於 `chat-gun` 內保留

#### Scenario: product policy 不得進 library

- **GIVEN** 一個契約表達 Chat Gun product policy、provider registry 或 deployment config
- **WHEN** 進行分類
- **THEN** 該契約歸為 `Chat Gun product contract` 或 `infrastructure adapter`
- **AND** MUST NOT 移入 `@gun-ai/harness-*`
