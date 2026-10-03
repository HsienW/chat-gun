# backup-restore Specification

## Purpose

定義 authoritative store 的備份／還原程序、隔離驗證、完整性檢查、restore drill 與 RPO/RTO 量測，確保還原程序不會以壞 backup 覆蓋正式 store、不完整 backup 在宣告可還原前被拒絕，且 recovery 掃描有界、可觀測、抗 retry storm。

## ADDED Requirements

### Requirement: authoritative store 具備備份程序

所有 authoritative store MUST 具備備份程序；non-authoritative store（Redis）MUST 標示為可自 authoritative facts 重建。encryption-key 依賴 MUST 以外部 KMS／環境變數記載，不得進入備份檔案或 repo。

#### Scenario: Postgres 可備份

- GIVEN Postgres authoritative store 具備備份程序
- WHEN 執行備份
- THEN MUST 產出可驗證的備份 artifact（含 schema version、timestamp、checksum）
- AND 備份內容 MUST 涵蓋 authoritative facts（含 idempotency ledger、side-effect ledger、ownership、events）

#### Scenario: non-authoritative store 標示為可重建

- GIVEN Redis 被視為 non-authoritative store
- WHEN 檢視備份與還原政策
- THEN Redis MUST 標示為可自 authoritative facts 重建
- AND MUST NOT 以 Redis 備份作為 authoritative data 還原來源

#### Scenario: encryption-key 依賴不進備份

- GIVEN encryption-key 依賴存在於外部 KMS／環境變數
- WHEN 產生備份 artifact
- THEN backup MUST NOT 含 plaintext key
- AND key 依賴 MUST 於 runbook 記載為 external dependency

### Requirement: 還原先隔離驗證再 promote

restore MUST 先於隔離驗證環境執行，驗證 schema version、idempotency ledger、event integrity 後才 promote 至正式環境；不得直接以未驗證 backup 覆蓋正式 store。

#### Scenario: 隔離環境驗證通過才 promote

- GIVEN 一份 backup artifact
- WHEN 執行 restore
- THEN MUST 先還原至隔離驗證環境並通過 integrity 檢查
- AND 通過後才 promote；未通過 MUST 中止且不覆蓋正式 store

#### Scenario: schema version 不一致中止

- GIVEN backup 的 schema version 與目前 runtime 不相容
- WHEN 隔離驗證
- THEN MUST 中止 restore
- AND MUST NOT promote

### Requirement: 不完整 backup 在宣告可還原前被拒絕

MUST 偵測不完整或不一致的 backup，並在宣告 restorable 前拒絕。restorable 的宣告 MUST 附完整性與一致性證據。

#### Scenario: checksum 不符拒絕 restorable

- GIVEN backup artifact 的 checksum 與實際內容不符
- WHEN 執行完整性檢查
- THEN MUST 判定不 restorable
- AND MUST 拒絕還原

#### Scenario: 缺 idempotency/side-effect ledger 不 restorable

- GIVEN backup 缺少 idempotency ledger 或 side-effect ledger
- WHEN 完整性檢查
- THEN MUST 判定不 restorable（因無法證明副作用不重複）
- AND MUST 拒絕宣告可還原

### Requirement: restore drill 量測 RPO/RTO 並產出證據

restore drill MUST 於隔離環境執行、量測實測 RPO/RTO、並與 deployment policy 目標比較，產出可追溯 evidence。drill 不得對正式 store 造成寫入。

#### Scenario: drill 完成並產出 RPO/RTO 證據

- GIVEN 一次 restore drill
- WHEN drill 完成
- THEN MUST 記錄實測 RPO、RTO、schema version、時間戳與驗證結果
- AND MUST 與 policy 目標比較並標示達標／未達標

#### Scenario: drill 不寫入正式 store

- GIVEN restore drill 於隔離環境執行
- WHEN 檢查正式 store
- THEN 正式 store MUST 無任何 drill 造成的寫入

### Requirement: recovery 掃描有界且抗 retry storm

recovery 掃描與 retries MUST 有界、可觀測、並 rate-limit，避免事故或演練後造成二次事故。

#### Scenario: recovery 掃描 rate-limited

- GIVEN 大量待恢復的 run
- WHEN 執行 recovery 掃描
- THEN MUST 以 rate-limit 進行，不得無界並發
- AND 掃描進度 MUST 可觀測

#### Scenario: 重試有界不無限 loop

- GIVEN 一個持續失敗的 recovery 目標
- WHEN 重試
- THEN MUST 有界（retry budget／deadline）
- AND 達界後 MUST 進入 park/dead-letter，不得無限重試
