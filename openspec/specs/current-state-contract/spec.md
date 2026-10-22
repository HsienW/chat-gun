# Current State Contract

## Purpose

本規格定義 current-state-contract 能力的正式需求，涵蓋其資料契約、狀態邊界、角色責任、失敗處理與驗證情境，作為實作、審查及後續演進的主要行為依據。

## Requirements

### Requirement: current-state.json 基本結構

每個 Change 的 Shared State MUST 儲存於 `.agent-runtime/<change-id>/current-state.json`，並符合 current-state.schema.json。

#### Scenario: 初始化 current-state.json

GIVEN CCR 開始 plan-change 階段
WHEN CCR 建立初始 current-state.json
THEN 檔案 MUST 包含 `schemaVersion`、`changeId`、`runId`、`currentPhase`、`currentOwner`、`attempt`、`latestArtifactRefs`、`latestHandoff`、`gateStatus`、`blockers`、`nextActions`、`updatedAt`、`terminalStatus`
AND `currentPhase` MUST 為 `"PLAN_DRAFT"`
AND `currentOwner` MUST 為 `"CCR"`
AND `terminalStatus` MUST 為 `"NON_TERMINAL"`

#### Scenario: plan-change 完成後推進到 PLAN_REVIEW

GIVEN CCR 完成 proposal/design/tasks/specs
WHEN CCR 準備交接給 Qwen review-plan
THEN CCR MUST 更新 current-state.json
AND `currentPhase` MUST 變為 `"PLAN_REVIEW"`
AND `currentOwner` MUST 變為 `"Qwen"`
AND `latestArtifactRefs` MUST 包含 proposal、design、tasks 的 reference

#### Scenario: current-state.json 不存在

GIVEN Agent 被指派處理某個 Change
WHEN `.agent-runtime/<change-id>/current-state.json` 不存在
THEN 若是 CCR 且任務為 plan-change：CCR MUST 初始化 current-state.json
AND 若是其他 Agent 或其他階段：Agent MUST 報錯並要求先初始化

---

### Requirement: currentPhase 與 currentOwner

`currentPhase` MUST 反映目前 Workflow Phase，`currentOwner` MUST 反映目前持有寫入權的 Agent。在 `rolePolicyVersion: "2"` 下，本 spec 情境中的 `"CCR"`、`"Codex"` 指該領域的主要角色；持有有效 Master 授權的次要角色 MAY 取代之，依 `agent-role-policy` 判定。

#### Scenario: 寫入權檢查

GIVEN current-state.json 的 `currentOwner` 為 `"Qwen"`
WHEN Codex 嘗試修改 OpenSpec 檔案
THEN Codex MUST NOT 執行修改
AND MUST 報錯說明目前 owner 不是 Codex

#### Scenario: Phase 與 Owner 對應

GIVEN `currentPhase` 為 `"REVIEWING"`
WHEN 檢查 `currentOwner`
THEN `currentOwner` MUST 為 `"Qwen"`

---

### Requirement: latestArtifactRefs 結構

`latestArtifactRefs` MUST 記錄各類最新 Artifact 的 Reference。

#### Scenario: 引用最新 proposal

GIVEN current-state.json 中 `latestArtifactRefs.proposal` 存在
WHEN Agent 需要讀取 proposal
THEN Agent MUST 依 `latestArtifactRefs.proposal.relativePath` 讀取
AND MUST NOT 掃描整個 openspec/changes/ 目錄尋找 proposal

#### Scenario: 缺少必要 ArtifactRef

GIVEN current-state.json 中 `latestArtifactRefs.design` 不存在
WHEN Agent 需要讀取 design
THEN Agent MUST 報錯並回報缺少必要 Artifact
AND MUST NOT 嘗試從其他來源猜測 design 位置

---

### Requirement: gateStatus 結構

`gateStatus` MUST 追蹤四個 Gate 的通過狀態。

#### Scenario: 所有 Gate 通過前不可進入 READY_FOR_ARCHIVE

GIVEN `gateStatus.proposalApproved` 為 `true`
AND `gateStatus.reviewPassed` 為 `true`
AND `gateStatus.implementationVerified` 為 `true`
AND `gateStatus.readinessConfirmed` 為 `false`
WHEN Agent 嘗試推進到 `READY_FOR_ARCHIVE`
THEN 狀態機 MUST 拒絕
AND 必須先完成 readiness-check

#### Scenario: implementationVerified 需實際驗證

GIVEN `gateStatus.implementationVerified` 為 `false`
WHEN 檢查原因
THEN MUST 存在未通過的 lint/test/build 證據
AND 不得在驗證未通過時標記為 `true`

---

### Requirement: blockers 追蹤

`blockers` MUST 記錄所有 unresolved Blocker。

#### Scenario: 有 Blocker 時不可推進

GIVEN `blockers` 陣列不為空
WHEN CCR 嘗試標記 `gateStatus.readinessConfirmed` 為 `true`
THEN 狀態機 MUST 拒絕
AND 所有 Blocker 必須先解決或明確接受風險

#### Scenario: Blocker 格式

GIVEN 一個 Blocker 項目
WHEN 檢查其結構
THEN MUST 包含 `severity`（Blocker）
AND MUST 包含 `description`
AND MUST 包含 `source`（來自哪個 review_result 的哪個 finding）
AND MUST 包含 `status`（`unresolved` | `accepted_risk` | `resolved`）

---

### Requirement: terminalStatus

`terminalStatus` MUST 區分 NON_TERMINAL 與 TERMINAL 狀態。

#### Scenario: TERMINAL 後不可修改

GIVEN `terminalStatus` 為 `"TERMINAL"`
AND `currentPhase` 為 `"COMPLETED"` 或 `"FAILED"`
WHEN 任何 Agent 嘗試修改 current-state.json 或 OpenSpec
THEN 除非由人工明確重置，否則 MUST 拒絕

#### Scenario: INCOMPLETE 保持可恢復

GIVEN `currentPhase` 為 `"INCOMPLETE"`
WHEN 檢查 `terminalStatus`
THEN `terminalStatus` MUST 為 `"NON_TERMINAL"`
AND Coordinator MAY 在補齊缺失輸入後依合法狀態轉移重新提交審查

#### Scenario: NON_TERMINAL 可繼續修改

GIVEN `terminalStatus` 為 `"NON_TERMINAL"`
WHEN 持有 `currentOwner` 的 Agent 完成工作後更新 current-state.json
THEN MUST 允許更新
AND `updatedAt` MUST 更新為當前時間

---

### Requirement: current-state.json 為單一事實來源

`current-state.json` MUST 是 Change 狀態的唯一事實來源。

#### Scenario: 不得依賴聊天紀錄推測狀態

GIVEN Agent 需要知道目前 Change 的階段
WHEN Agent 讀取 `current-state.json` 的 `currentPhase`
THEN 以該值為準
AND Agent MUST NOT 依賴聊天紀錄、使用者口語描述或上一個 Agent 的摘要來推測階段

#### Scenario: 狀態衝突時以 current-state.json 為準

GIVEN Handoff 中描述的階段與 current-state.json 的 `currentPhase` 不一致
WHEN Agent 判斷應執行哪個階段
THEN MUST 以 `current-state.json` 為準
AND MUST 回報衝突

---

### Requirement: current-state.json 更新責任

每次 Agent 完成工作後，MUST 有明確的 Agent 負責更新 current-state.json。

#### Scenario: CCR 完成 plan-change 後更新

GIVEN CCR 完成 proposal/design/tasks 建立
WHEN CCR 準備交接給 Qwen
THEN CCR MUST 更新 current-state.json 的 `currentPhase` 為 `"PLAN_REVIEW"`
AND CCR MUST 更新 `currentOwner` 為 `"Qwen"`
AND CCR MUST 更新 `latestArtifactRefs` 包含 proposal、design、tasks

#### Scenario: Codex 完成實作後更新

GIVEN Codex 完成 IMPLEMENTING 階段
WHEN Codex 準備交接給 Qwen 進行 review-result
THEN Codex MUST 更新 current-state.json 的 `currentPhase` 為 `"READY_FOR_REVIEW"`
AND Codex MUST 更新 `latestArtifactRefs.implementationResult` 指向新的 implementation_result
AND Codex MUST 更新 `evidence/` 中的相關檔案

#### Scenario: Qwen 完成審查後由人工更新

GIVEN Qwen 完成 review-plan 或 review-result 審查
WHEN Qwen 輸出 review_result 到 stdout
THEN Qwen MUST NOT 直接修改 current-state.json（唯讀邊界）
AND 人工或 CLIHost MUST 依 Qwen 的輸出更新 current-state.json 的 `currentPhase`、`currentOwner` 與 `latestArtifactRefs.reviewResult`
AND 更新時機 MUST 在 review_result 成功保存為 Runtime Artifact 之後

#### Scenario: CCR 仲裁後更新

GIVEN CCR 完成 readiness-check 或 NEEDS_COORDINATOR_ARBITRATION 仲裁
WHEN CCR 判定下一步
THEN CCR MUST 更新 current-state.json 的 `currentPhase`、`currentOwner`、`gateStatus` 與 `blockers`

#### Scenario: 更新時必須驗證前置條件

GIVEN Agent 準備更新 current-state.json
WHEN 檢查前置條件
THEN Agent MUST 確認目前 `currentOwner` 為該 Agent 或為 CCR（CCR 可隨時更新）
AND Agent MUST 確認目標 Phase 為合法轉移（見 workflow-state-transition spec）
AND Agent MUST 更新 `updatedAt` 為當前時間
