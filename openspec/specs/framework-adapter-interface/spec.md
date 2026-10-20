# framework-adapter-interface Specification

## Purpose
定義 backend 私有、框架中立的 adapter port、capability/version 驗證及第二 adapter conformance，保留既有 runtime 權威。公開化須另經 additive change 與 package ownership、版本及 consumer 驗收。
## Requirements
### Requirement: 框架中立 adapter 契約與 capability 宣告

Runtime MUST 定義僅含必要 invocation、step observation、checkpoint reference、wait/resume、event source、cancel 與 terminal observation 的框架中立 adapter 契約及 capability/version 宣告。Adapter MUST NOT 擁有 trusted identity、authorization decision、tool execution、side-effect ledger 或產品 terminal 的寫入權；缺失的必要 capability MUST fail closed。

#### Scenario: 相容 adapter 註冊
- **WHEN** adapter 的契約版本與必要 capabilities 均受支援
- **THEN** host MUST 可組裝並由同一權威 runtime 管理執行
- **AND** framework 專屬 opaque 物件 MUST 不出現在穩定公共契約

#### Scenario: 缺少能力或版本不相容
- **WHEN** adapter 未宣告 cancel、wait/resume 等必要能力，或契約版本未知
- **THEN** 註冊/呼叫 MUST 以 typed unsupported outcome 拒絕
- **AND** MUST NOT 默認開啟不受治理的 fallback

#### Scenario: Adapter 初始化逾時或取消
- **WHEN** adapter 初始化超過 policy 期限或被取消
- **THEN** host MUST 不對流量公開該 adapter，也不得留下部分註冊

### Requirement: 第二 adapter 證明框架可替換

至少一個不依賴 LangGraph 的最小 reference adapter MUST 使用同一契約完成 invocation、step、event、wait/resume、cancel、version failure 與 terminal conformance。新增該 adapter MUST NOT 修改 kernel 或建立產品專用的平行執行器。

#### Scenario: Reference adapter 通過共用情境
- **WHEN** 最小第二 adapter 執行既定的成功、等待/恢復與取消情境
- **THEN** MUST 產生與 LangGraph adapter 同語意的產品 identity、event、tool dispatch 與唯一 terminal evidence
- **AND** 不得引入對 LangGraph 或產品私有 state 的穩定契約相依

#### Scenario: Reference adapter 失敗與逾時
- **WHEN** 第二 adapter 回報 node 失敗、checkpoint 版本不相容或 deadline 逾時
- **THEN** MUST 以相同 typed failure/recovery taxonomy 與受信政策收斂
- **AND** 不得繞過 idempotency、authorization 或 side-effect evidence

#### Scenario: 取消競態
- **WHEN** 第二 adapter 的完成與取消競態發生
- **THEN** MUST 由同一產品 terminal guard 保證唯一終態
- **AND** 不得因 framework 更換而重放已提交的外部效果

### Requirement: 公開邊界與相容性證據

新增 public adapter 契約或跨套件輸出 MUST 有明確 package ownership、版本、API-surface、unsupported-version 行為與 rollback 證據。框架/產品/DB client 相依 MUST 不進入 framework-neutral 契約或 kernel；正式 consumer 驗收 MUST 使用可追溯的套件來源。

#### Scenario: 新公開符號
- **WHEN** adapter 契約需要新增 public symbol
- **THEN** MUST 經 owning package 的 API-surface 與版本審查，並具備相容性測試
- **AND** consumer MUST 能區分受支援版本與 typed unsupported version

#### Scenario: 邊界違規
- **WHEN** 中立套件 import 框架、產品或資料庫客戶端，或出現套件 cycle
- **THEN** automated boundary/cycle gate MUST fail
- **AND** 不得以本機連結通過代替可追溯的 consumer 驗收

#### Scenario: 回滾與中斷
- **WHEN** 新 adapter 部署後須回滾或執行中途被取消
- **THEN** 既有已存事件/checkpoint/side-effect evidence MUST 可由相容版本讀取或明確 park
- **AND** 不得靜默修改持久格式或重播不確定副作用

### Requirement: 框架中立 port 先私有、公開化獨立 gate

X28 的 framework-neutral adapter port、capability/version 宣告與 checkpoint adapter metadata schema MUST 在 `backend` 內維持單一來源的私有 port，不得從任何 `@gun-ai/harness-*` 套件 export，亦不得被標示為已發布 public 契約。提升為 public API MUST 是獨立 additive change，須先有可驗證的外部 consumer use case，並完成 owning package、`@since` 版本、API-surface snapshot、semver 與 rollback 審查後重新 review-plan。

#### Scenario: 私有 port 不得對外發布
- **WHEN** X28 在 backend 內定義 framework-neutral port 與 capability/version 宣告
- **THEN** 該 port MUST 有單一來源與型別，MUST NOT 從 `@gun-ai/harness-contracts`／`kernel`／`testkit` export
- **AND** 文件與 audit MUST 標示為 internal，不宣稱 public portability

#### Scenario: 無外部 use case 不公開
- **WHEN** 尚無 chat-gun 以外的 consumer 實作並消費該 port
- **THEN** MUST NOT 將 port 或 metadata schema 加入 `@gun-ai/harness-*` 公開面
- **AND** 不得以「預留」或「未來可能需要」為由公開 internal 型別

#### Scenario: 公開化走獨立 gate
- **WHEN** 出現可驗證的外部 use case 需要公開該 port
- **THEN** MUST 以獨立 additive change 提案並重新 review-plan
- **AND** MUST 完成 owning package、版本、API-surface snapshot、consumer 安裝與 rollback 審查後才發布
- **AND** 不得由實作階段順手新增 public export
