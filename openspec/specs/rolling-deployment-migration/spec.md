# rolling-deployment-migration Specification

## Purpose
TBD - created by archiving change high-availability-backup-and-disaster-recovery. Update Purpose after archive.
## Requirements
### Requirement: migration 前向 additive-only

migration 前向 MUST 只 add（backward-compatible），MUST NOT drop 既有欄位或改變既有欄位語意。rolling deploy 期間 old+new instance MUST 能對同一 schema 並存運作。

#### Scenario: 前向 migration 不 drop 既有欄位

- GIVEN 一支新的前向 migration
- WHEN 檢視其內容
- THEN MUST 只 add 欄位／表，不 drop 或 rename 既有欄位
- AND MUST NOT 改變既有欄位語意

#### Scenario: old+new instance 並存可運作

- GIVEN rolling deploy 期間 old 與 new instance 同時對同一 schema 運作
- WHEN 兩者處理工作
- THEN MUST 皆能運作
- AND 新欄位 MUST 為 nullable／有 default，不破壞 old instance 的寫入

### Requirement: mixed-version 相容性檢查

MUST 提供 schema/event/package version 相容性檢查；不相容的 mixed-version 組合 MUST 被偵測並拒絕，不得靜默降級。

#### Scenario: 不相容 version 組合被拒

- GIVEN old instance 使用不相容的 event/schema/package version
- WHEN rolling deploy 或 resume
- THEN MUST 回報 typed compatibility failure
- AND MUST NOT 以不安全的近似繼續

#### Scenario: 支援的 mixed-version 組合有 CI 證據

- GIVEN 受支援的 mixed schema/event/package version 組合
- WHEN 執行 rolling-deployment 測試
- THEN MUST 有 CI 證據證明相容
- AND 未測試組合 MUST 標示為 unknown，不宣稱 supported

### Requirement: rolling deployment 組合 drain 與 canary

rolling deployment MUST 組合既有 `drainRuntime` 與 `runLiveRuntimeCanary`：舊 instance 先 stop new claims 並 drain，再以 canary 驗證 new instance 後才放量。

#### Scenario: 舊 instance drain 後才停

- GIVEN 一次 rolling deploy
- WHEN 舊 instance 準備下線
- THEN MUST 先 stop new claims 並 drain in-flight work
- AND drain 結果 MUST 區分 completed／checkpointed／parked／reconciled／unresolved

#### Scenario: canary 通過才放量

- GIVEN new instance 上線
- WHEN 放量前
- THEN MUST 以 canary 驗證（task/step/checkpoint/resume/verify 循環）
- AND canary unhealthy 時 MUST 停止放量

### Requirement: resume 於不相容 version 下拒絕

resume 於 required code/schema/checkpoint version 不支援時 MUST 拒絕並回報 typed、operator/user-safe 的解決路徑，不得造成 state corruption。

#### Scenario: 不支援的 checkpoint version 拒絕 resume

- GIVEN 一個 checkpoint 的 schema version 不被目前 runtime 支援
- WHEN 嘗試 resume
- THEN MUST 拒絕並回報 typed compatibility failure
- AND MUST NOT 部分寫入造成 state corruption

#### Scenario: 相容 checkpoint 正常 resume

- GIVEN 一個 checkpoint 的 version 受支援
- WHEN resume
- THEN MUST 正常恢復並延續既有 sequence 與 terminal contract
