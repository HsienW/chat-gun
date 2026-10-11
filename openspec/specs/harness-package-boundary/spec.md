# harness-package-boundary Specification

## Purpose
規範 contracts、kernel 與 testkit 的依賴方向、Zod v3 與框架邊界、cycle 檢查，以及 public alpha 套件的獨立 registry 安裝要求。
## Requirements
### Requirement: 三套件與固定依賴方向

抽取 MUST 建立 `@gun-ai/harness-contracts`、`@gun-ai/harness-kernel`、`@gun-ai/harness-testkit` 三個套件，依賴方向固定為 `contracts ← kernel ← testkit`，反向或跨向 product 一律禁止。

#### Scenario: kernel 依賴 contracts 而非反向

- **GIVEN** `@gun-ai/harness-kernel` 需要 failure taxonomy 型別
- **WHEN** 宣告依賴
- **THEN** `kernel` 依賴 `contracts`
- **AND** `contracts` MUST NOT 依賴 `kernel`、`testkit` 或任何 product code

#### Scenario: testkit 依賴 contracts 與 kernel

- **GIVEN** `@gun-ai/harness-testkit` 需要 deterministic clock 與 failure fixture
- **WHEN** 宣告依賴
- **THEN** `testkit` 可依賴 `contracts` 與 `kernel`
- **AND** MUST NOT 被 `contracts` 或 `kernel` 依賴

### Requirement: contracts 只持型別/schema/enum，不含 runtime 函式

`@gun-ai/harness-contracts` MUST 只含型別、interface、Zod schema 與 enum（含封閉 domain constant），MUST NOT 包含任何會在 runtime 產生值的函式（事件 factory、id 產生、hash、解析、投影等）；這些原語歸 `kernel` 或留 `chat-gun`。`contracts` MUST NOT import `node:*`。

#### Scenario: 事件 factory 不進 contracts

- **GIVEN** `events.ts` 的事件 factory 函式呼叫 `stableEventId()` 與 `executionCorrelation()`
- **WHEN** 進行抽取
- **THEN** 事件 factory 留 `chat-gun`
- **AND** `contracts` 只持 `TaskEvent` 等型別
- **AND** `stableEventId` 歸 `kernel`，不形成 `contracts` 反向依賴 `kernel`

#### Scenario: 型別/schema/常數與函式分離

- **GIVEN** 一個檔混著型別、Zod schema、runtime 函式與常數（如 `event-envelope.ts`、`side-effect/identity.ts`）
- **WHEN** 進行抽取
- **THEN** 型別/schema/常數 → `contracts`、純函式 → `kernel`、product 投影/assembly → `chat-gun`
- **AND** `contracts` 不 import `node:crypto` 等 Node runtime 依賴（Zod v3 schema validation 依賴除外）

### Requirement: 抽出套件不得依賴 product 框架

`@gun-ai/harness-*` MUST NOT import React、LangChain、Express、database client、model SDK 或 chat-gun application module；product-specific 依賴只在 `chat-gun` 的 composition root 安裝。

#### Scenario: 抽取套件乾淨無框架依賴

- **GIVEN** `@gun-ai/harness-contracts` 只含 9 大契約家族的型別/schema
- **WHEN** 執行 dependency boundary check
- **THEN** 任何 import React/LangChain/DB client/model SDK/chat-gun module 的路徑 MUST 被偵測並阻斷
- **AND** 契約型別無 product/framework 依賴（僅 Zod v3 runtime dependency）

### Requirement: 自動化 cycle/boundary check

`chat-gun` MUST 提供 automated boundary/cycle check，以真實 import/symbol 為基礎，偵測 `@gun-ai/harness-*` 反向依賴與套件間 cycle，並以 production sources + 故意違規 fixture 驗證。

#### Scenario: 故意違規 fixture 被阻斷

- **GIVEN** 一個 fixture 讓 `@gun-ai/harness-contracts` import chat-gun module
- **WHEN** 執行 boundary check
- **THEN** 該 fixture MUST fail
- **AND** production sources 全部 pass

#### Scenario: 套件間 cycle 被阻斷

- **GIVEN** 一個 fixture 造成 contracts/kernel/testkit 之間 cycle
- **WHEN** 執行 cycle check
- **THEN** 該 fixture MUST fail
- **AND** 合法依賴方向 pass

### Requirement: 已發布 public alpha 可獨立安裝

三個套件 MUST 以 `@gun-ai` scope 提供 public `0.1.0-alpha.1` 已發布版本，使用 `alpha` dist-tag、精確的套件間相依版本與編譯後的 JavaScript／型別宣告；workspace root MUST 維持 private。實際發布須經 Human 核准，不得以本地連結或 dry-run 冒充已發布版本。本地 Git SHA 僅錨定 Chat Gun 驗收修訂（程式碼 clone 來源），不替代 registry package 安裝來源。

#### Scenario: 匿名 consumer 安裝已發布 alpha

- **GIVEN** Human 已依 `contracts`、`kernel`、`testkit` 順序發布三個 alpha 套件
- **WHEN** 不具備 sibling checkout 的 consumer 從公開 registry 安裝精確版本
- **THEN** 三個套件與其精確相依版本均可匿名取得
- **AND** runtime JavaScript 與型別宣告均可解析

#### Scenario: 尚未發布或版本缺漏

- **GIVEN** 任一套件尚未發布，或相依版本無法從 registry 取得
- **WHEN** consumer 嘗試安裝
- **THEN** X26 portable install gate MUST fail
- **AND** 本地 `file:` 連結、pack 或 publish dry-run MUST NOT 被視為通過證據

