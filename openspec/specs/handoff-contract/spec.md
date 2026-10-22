# Structured Handoff Contract

## Purpose

本規格定義 handoff-contract 能力的正式需求，涵蓋其資料契約、狀態邊界、角色責任、失敗處理與驗證情境，作為實作、審查及後續演進的主要行為依據。

## Requirements

### Requirement: Handoff Envelope 結構

每次 Agent 之間的交接 MUST 使用 Structured Handoff Envelope。

#### Scenario: 正常 plan-change → review-plan 交接

GIVEN CCR 完成 proposal/design/tasks
WHEN CCR 產生 Handoff 給 Qwen 進行 review-plan
THEN Handoff MUST 包含 `handoffId`、`changeId`、`runId`、`from`、`to`、`stage`、`reason`
AND `from` MUST 為 `"CCR"`
AND `to` MUST 為 `"Qwen"`
AND `stage` MUST 為 `"review-plan"`
AND `requiredInputRefs` MUST 引用 coordinator_result 與 OpenSpec 四件套
AND `expectedOutputKind` MUST 為 `"review_result"`

#### Scenario: review-result → fix-from-review 交接

GIVEN Qwen 完成 review-result 並回報 Blocker
WHEN CCR 產生 Handoff 給 Codex 進行 fix-from-review
THEN `requiredInputRefs` MUST 引用 review_result（包含 Qwen findings）
AND `expectedOutputKind` MUST 為 `"implementation_result"`
AND `onFailure` MUST 指向 `NEEDS_COORDINATOR_ARBITRATION`

---

### Requirement: requiredInputRefs 完整性

Handoff MUST 在 `requiredInputRefs` 中明確列出接收方需要的所有上游 Artifact。

#### Scenario: 缺少必要 inputRef

GIVEN Handoff 給 Qwen 進行 review-result
WHEN `requiredInputRefs` 中缺少 implementation_result 或 evidence 的 reference
THEN Qwen MUST 標記審查為 `INCOMPLETE`
AND Qwen MUST 回報缺少的必要輸入

#### Scenario: inputRef 指向不存在的檔案

GIVEN Handoff 中 `requiredInputRefs` 引用了一個不存在的檔案路徑
WHEN 接收方 Agent 嘗試讀取
THEN Agent MUST 報錯
AND MUST NOT 以空資料或猜測繼續執行

---

### Requirement: expectedOutputKind 約定

Handoff MUST 指定接收方應產生的 Artifact kind。

#### Scenario: 輸出 kind 不匹配

GIVEN Handoff 指定 `expectedOutputKind` 為 `"review_result"`
WHEN 接收方 Agent 的輸出 kind 不是 `"review_result"`
THEN 該輸出 MUST NOT 被接受為本次 Handoff 的合法完成
AND 狀態機 MUST NOT 推進到下一個 phase

---

### Requirement: onSuccess / onFailure / onConflict 路由

Handoff MUST 定義成功、失敗與衝突時的下一步路由。

#### Scenario: 審查通過後路由

GIVEN Qwen 完成 review-plan 且 Verdict 為 `APPROVE`
WHEN 依據 Handoff 的 `onSuccess` 路由
THEN `nextStage` MUST 為 `"apply-change"`
AND `nextOwner` MUST 為 `"Codex"`

#### Scenario: 審查要求修改後路由

GIVEN Qwen 完成 review-plan 且 Verdict 為 `REQUEST_CHANGES`
WHEN 依據 Handoff 的 `onFailure` 路由
THEN `nextStage` MUST 為 `"plan-change"`
AND `nextOwner` MUST 為 `"CCR"`
AND `reason` MUST 說明為何需要 CCR 重新協調

#### Scenario: 衝突時仲裁路由

GIVEN Codex 與 Qwen 對同一個修改有不同判斷
WHEN 依據 Handoff 的 `onConflict` 路由
THEN `strategy` MUST 為 `"coordinator_arbitration"`
AND `nextOwner` MUST 為 `"CCR"`

---

### Requirement: Handoff 生命週期

Handoff MUST 追蹤其生命週期狀態。

#### Scenario: Handoff 狀態轉移

GIVEN 一個 Handoff 的初始狀態為 `PENDING`
WHEN 接收方 Agent 確認承接
THEN 狀態 MUST 更新為 `ACCEPTED`
WHEN 接收方 Agent 開始工作
THEN 狀態 MUST 更新為 `IN_PROGRESS`
WHEN 接收方 Agent 完成工作
THEN 狀態 MUST 更新為 `COMPLETED`

#### Scenario: Handoff 逾時

GIVEN 一個 Handoff 長時間未被承接（狀態為 `PENDING`）
WHEN 超過合理時間（由人判斷）
THEN 狀態 MAY 更新為 `EXPIRED`
AND 需要重新產生 Handoff

---

### Requirement: requiresHumanApproval 旗標

Handoff MUST 使用 `requiresHumanApproval` 旗標標示是否需要人工批准後才能繼續。

#### Scenario: 不需要人工批准的交接

GIVEN CCR 交給 Qwen 進行 review-plan
WHEN `requiresHumanApproval` 為 `false`
THEN Qwen 可以直接開始審查，不需等待人工確認

#### Scenario: 需要人工批准的交接

GIVEN 狀態機準備進入 `ARCHIVED_AWAITING_HUMAN_COMMIT`
WHEN 該階段 Handoff 的 `requiresHumanApproval` 為 `true`
THEN Agent MUST NOT 在無人確認下繼續
AND 狀態 MUST 停留在當前 phase 直到人工批准

---

### Requirement: Handoff 不複製 Artifact 內容

Handoff MUST 只傳遞 ArtifactReference，不複製完整 Artifact 內容。

#### Scenario: Handoff 中的 ArtifactReference

GIVEN Handoff 的 `requiredInputRefs` 中有一個 ArtifactReference
WHEN 檢查該 reference
THEN 它 MUST 包含 `artifactId`、`changeId`、`relativePath`
AND 它 MUST NOT 包含完整 Artifact 內容（如 proposal 全文）
AND 接收方 MUST 依 reference 讀取完整 Artifact

### Requirement: 角色政策欄位
Handoff MAY 帶有 `rolePolicyVersion`、`actingRole`、`writeScope` 與 `authorizationRef`。`actingRole` 為 `planning_secondary` 或 `implementation_secondary` 時，MUST 同時提供 `rolePolicyVersion: "2"`、`authorizationRef` 與 `writeScope`。

#### Scenario: 次要角色 Handoff 缺少授權引用
- GIVEN Handoff 的 `actingRole` 為 `implementation_secondary`
- WHEN 缺少 `authorizationRef` 或 `writeScope`
- THEN Schema 驗證 MUST 失敗

#### Scenario: 舊 Handoff 相容
- GIVEN 既有 Handoff 沒有角色政策欄位
- WHEN 以新 Schema 驗證
- THEN MUST 通過
