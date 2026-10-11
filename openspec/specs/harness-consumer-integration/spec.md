# harness-consumer-integration Specification

## Purpose
規範 Chat Gun 透過 adapter 消費已發布的 harness registry 套件、避免平行本地定義，並以獨立 clean-clone 與回滾驗證維持 durable-state 相容性。
## Requirements
### Requirement: chat-gun 經 adapter 消費、無平行本地定義

`chat-gun` MUST 透過 adapter 消費抽出的契約，移除平行本地定義，不得長期維持 chat-gun 與 `gun-harness` 兩份重複定義。

#### Scenario: 消費後無平行定義

- **GIVEN** `@gun-ai/harness-contracts` 已包含 execution identity 與 task/step/run lifecycle 型別
- **WHEN** `chat-gun` 完成 consumer refactor
- **THEN** `chat-gun` 不再保有 `ExecutionContext`／`TaskStatus`／`AgentTask` 等平行本地定義
- **AND** 既有 import 改經 adapter 別名／re-export，語意不變

#### Scenario: boundary check 證明無平行定義

- **GIVEN** `chat-gun` 有一個 `chat-gun-parallel-local-definition` 檢查
- **WHEN** 執行檢查
- **THEN** 本地平行定義的路徑 MUST fail
- **AND** production sources 全部 pass

### Requirement: 一次一契約家族、立即 adapt

抽取 MUST 一次移動一個契約家族並立即 adapt `chat-gun`，不得在未 adapt 前留下長期重複定義。

#### Scenario: 抽取與 adapt 同步

- **GIVEN** 進行一個契約家族的抽取
- **WHEN** 該家族移入 `@gun-ai/harness-*`
- **THEN** `chat-gun` 於同一增量改為消費
- **AND** `backend` lint/test/build 全綠

### Requirement: 回滾不失 durable-state 相容

`chat-gun` MUST 能回滾到前一 `@gun-ai/harness-*` package version（或前一 commit 的本地定義）而不失去 durable-state 相容性；抽取不變更既有 checkpoint/event/side-effect 序列化格式。

#### Scenario: downgrade 後既有資料可讀

- **GIVEN** `chat-gun` 依賴 `@gun-ai/harness-contracts@1.0`
- **WHEN** downgrade 到前一 version 或還原本地定義
- **THEN** 既有 checkpoint/event/side-effect 序列化資料仍可讀
- **AND** durable-state 相容性由回滾 test 保證

### Requirement: Chat Gun 消費已發布 registry alpha，並以本地 Git 修訂完成 portable clean-clone

X26 完成前，`chat-gun` MUST 將三個 harness 相依套件固定為公開 registry 的精確 `0.1.0-alpha.1` 版本與 lockfile；Chat Gun 原始碼來源為包含實作與本 OpenSpec change 的已提交本地 SHA，並在沒有 sibling `gun-harness` checkout、repo-local staging 或 workspace hoisting 的獨立 clone 中完成安裝、lint、test、build、依賴來源核對與同修訂 OpenSpec strict。

#### Scenario: 獨立 clone 成功驗收

- **GIVEN** 三個 public alpha 套件已可匿名取得，且 Chat Gun 修訂（含本 OpenSpec change）已提交為本地 SHA，不需 remote push
- **WHEN** 以 `git clone --no-local` 從該本地 SHA 建立獨立 clone，並以 lockfile 安裝及驗證
- **THEN** 安裝、lint、完整 test、build、邊界檢查與同修訂 OpenSpec strict 均通過
- **AND** 三個相依套件解析自 registry 版本，而非本地連結

#### Scenario: 無 sibling 時無法安裝

- **GIVEN** consumer 仍依賴 sibling `file:` 路徑或 repo-local staging
- **WHEN** 在獨立 clone 中安裝
- **THEN** portable clean-clone gate MUST fail
- **AND** 不得宣告 X26 完成或進入 archive

