# Qwen Read-only Result Capture

## Purpose

本規格定義 qwen-readonly-result-capture 能力的正式需求，涵蓋其資料契約、狀態邊界、角色責任、失敗處理與驗證情境，作為實作、審查及後續演進的主要行為依據。

## Requirements

### Requirement: Qwen 唯讀邊界保留

Qwen 的唯讀邊界 MUST 保持不變：Qwen 不得寫入任何檔案。

#### Scenario: Qwen 不直接寫入 Runtime Artifact

GIVEN Qwen 完成 review-plan 審查
WHEN Qwen 需要產出 review_result
THEN Qwen MUST NOT 呼叫 Write 或 Edit Tool
AND Qwen MUST NOT 直接寫入 `.agent-runtime/` 下的任何檔案
AND Qwen MUST 只輸出到 stdout 或聊天回應

#### Scenario: Qwen 唯讀設定不變

GIVEN `.qwen/settings.json` 的權限設定
WHEN 檢查 `permissions.deny`
THEN MUST 包含 `"Edit"`、`"Write"`、`"Bash"`
AND 本 Change MUST NOT 放寬這些限制

---

### Requirement: Qwen 輸出 Agent Result JSON

Qwen MUST 輸出符合 `agent-result.schema.json` 的 review_result，於標準 markdown 輸出之外提供結構化 JSON。

#### Scenario: review_result JSON 輸出

GIVEN Qwen 完成 review-plan 審查
WHEN Qwen 輸出結果
THEN 除了標準 markdown 格式（依 QWEN.md §11）
AND Qwen MUST 同時輸出一個符合 `agent-result.schema.json` 的 JSON 物件（可包在 markdown code fence 中）
AND JSON 的 `kind` MUST 為 `"review_result"`
AND JSON 的 `producer` MUST 為 `"Qwen"`

#### Scenario: JSON 與 markdown 一致性

GIVEN Qwen 輸出的 review_result JSON 與 markdown Finding
WHEN 人工核對
THEN JSON 中的 `payload.verdict` MUST 與 markdown 中的 Verdict 一致
AND JSON 中的 `payload.findings` MUST 與 markdown 中的 Findings 對應

---

### Requirement: Verdict 驅動的 CurrentState Transition

Adapter MUST 依 review_result payload.verdict 執行 phase、owner、gate 與 blocker 轉換。

#### Scenario: APPROVE transition

GIVEN review_result 的 `payload.verdict` 為 `APPROVE`
WHEN adapter 寫入 `current-state.json`
THEN `currentPhase` MUST 設為 `READY_FOR_READINESS_CHECK`
AND `currentOwner` MUST 設為 `CCR`
AND `gateStatus.reviewPassed` MUST 為 `true`
AND `latestHandoff.status` MUST 設為 `COMPLETED`
AND `nextActions` MUST 包含「CCR 執行 readiness check」

#### Scenario: REQUEST_CHANGES transition

GIVEN review_result 的 `payload.verdict` 為 `REQUEST_CHANGES`
WHEN adapter 寫入 `current-state.json`
THEN `currentPhase` MUST 設為 `CHANGES_REQUESTED`
AND `currentOwner` MUST 設為 `Codex`
AND `gateStatus.reviewPassed` MUST 為 `false`
AND `blockers` MUST 包含所有 blocker 和 major findings（severity: Blocker, status: unresolved）
AND `nextActions` MUST 包含修正指示

#### Scenario: INCOMPLETE transition

GIVEN review_result 的 `payload.verdict` 為 `INCOMPLETE`
WHEN adapter 寫入 `current-state.json`
THEN `currentPhase` MUST 設為 `INCOMPLETE`
AND `currentOwner` MUST 設為 `CCR`
AND `gateStatus.reviewPassed` MUST 為 `false`
AND `latestHandoff.status` MUST 設為 `FAILED`

#### Scenario: COMMENT_ONLY transition

GIVEN review_result 的 `payload.verdict` 為 `COMMENT_ONLY`
AND findings 無 blocker 或 major
WHEN adapter 寫入 `current-state.json`
THEN `currentPhase` MUST 設為 `READY_FOR_READINESS_CHECK`
AND `currentOwner` MUST 設為 `CCR`
AND `gateStatus.reviewPassed` MUST 為 `true`
AND `latestHandoff.status` MUST 設為 `COMPLETED`

---

### Requirement: Canonical CurrentState Schema Validation

Adapter MUST 驗證 current-state.json 符合 `current-state.schema.json` 根層 schema。

#### Scenario: 拒絕非 canonical current-state.json

GIVEN current-state.json 缺少根層 required field（如 `currentPhase`, `currentOwner`, `gateStatus`）
OR 使用舊 coordinator_result wrapper 形狀
WHEN adapter 讀取 current-state.json
THEN adapter MUST 拋出明確的 schema validation error
AND MUST 指出缺少的欄位名稱
AND MUST NOT 寫入任何檔案

---

### Requirement: review_result 保存方式

Qwen review workflow MUST 由 `qwen-capture-adapter.mjs` wrapper 啟動，確保 review_result 自動保存與 CurrentState 轉換。

#### Scenario: CLIHost adapter wrapper 強制保存

GIVEN Qwen review 需要執行
AND CurrentState 的 `currentPhase` 為 `REVIEWING`
AND CurrentState 符合 `current-state.schema.json` 根層 schema
WHEN CLIHost 透過 `node tools/qwen-capture-adapter.mjs --change-id <change-id> --run-id <run-id> -- qwen <args...>` 啟動 Qwen
AND Qwen 輸出包含符合 `agent-result.schema.json` 的 review_result JSON
THEN adapter MUST 從 stdout 提取並驗證 JSON
AND adapter MUST 寫入 `.agent-runtime/<change-id>/artifacts/review-result.json`
AND adapter MUST 依 verdict 更新 `current-state.json`：
  - `APPROVE` → `currentPhase: "READY_FOR_READINESS_CHECK"`, `currentOwner: "CCR"`, `gateStatus.reviewPassed: true`
  - `COMMENT_ONLY` → `currentPhase: "READY_FOR_READINESS_CHECK"`, `currentOwner: "CCR"`, `gateStatus.reviewPassed: true`
  - `REQUEST_CHANGES` → `currentPhase: "CHANGES_REQUESTED"`, `currentOwner: "Codex"`, `gateStatus.reviewPassed: false`, blockers 來自 findings
  - `INCOMPLETE` → `currentPhase: "INCOMPLETE"`, `currentOwner: "CCR"`, `gateStatus.reviewPassed: false`, `latestHandoff.status: "FAILED"`
AND adapter MUST 更新 `latestHandoff.status` 與 `latestArtifactRefs.reviewResult`
AND adapter MUST 原子寫入（atomic write）所有檔案

#### Scenario: 直接啟動 Qwen 不可保存

GIVEN Qwen 被直接啟動（不經由 adapter wrapper）
WHEN Qwen 完成 review 並輸出 review_result JSON
THEN Qwen MUST NOT 自行寫入 `.agent-runtime/`
AND 人工 MUST 手動執行 adapter 或手動複製 JSON 到 artifact 路徑
AND 人工 MUST 手動更新 `current-state.json` 的 phase、owner、gateStatus

#### Scenario: CLIHost adapter wrapper 保存（legacy fallback）

GIVEN current-state.json 不符合 canonical 根層 schema（缺少 required field）
WHEN adapter 嘗試讀取
THEN adapter MUST 拒絕並回報 schema validation error
AND 不得寫入任何檔案

#### Scenario: 人工複製保存

GIVEN Qwen 輸出 review_result JSON
WHEN 人工從 Qwen 輸出複製 JSON 內容
AND 手動寫入 `.agent-runtime/<change-id>/artifacts/review-result.json`
THEN 寫入後 `current-state.json` 的 `latestArtifactRefs.reviewResult` MUST 更新為指向該檔案

#### Scenario: 輸出格式不合法

GIVEN Qwen 輸出內容不包含有效的 review_result JSON
WHEN CLIHost 或人工嘗試提取或驗證
THEN MUST 拒絕保存
AND MUST 回報格式不合法
AND 不得將不合法內容寫入 artifact 路徑

---

### Requirement: INCOMPLETE 條件

Qwen MUST 在無法完成可靠審查時輸出 INCOMPLETE。

#### Scenario: 缺少 Base/Diff/關鍵驗證

GIVEN Qwen 被指派 review-plan 或 review-result
WHEN Coordinator 沒有提供 Base Ref、Diff 或關鍵驗證證據
THEN Qwen MUST 在 Verdict 中輸出 `INCOMPLETE`
AND MUST 列出所有缺失的輸入

#### Scenario: 百煉認證或模型無法確認

GIVEN Qwen 無法確認百煉認證或千問模型
WHEN Qwen 嘗試開始審查
THEN Qwen MUST 在 Verdict 中輸出 `INCOMPLETE`
AND MUST 在 Scope 中標示 model 為 `unverified`

#### Scenario: 唯讀邊界可能被覆蓋

GIVEN Qwen 的父工作階段權限設定可能覆蓋 Subagent 的 `plan` 邊界
WHEN Qwen 檢測到此情況
THEN Qwen MUST 停止審查並輸出 `INCOMPLETE`
AND MUST 說明權限衝突

---

### Requirement: 不新增 Qwen 的 Tool 或權限

本 Change MUST NOT 為 Qwen 新增任何 Write、Edit、Bash 或網路存取權限。

#### Scenario: 權限白名單不變

GIVEN `.qwen/settings.json` 和 `.qwen/agents/secondary-architecture-reviewer.md`
WHEN 本 Change 完成
THEN Qwen 的 Tool 白名單 MUST 僅限 read_file、grep_search、glob、list_directory、skill
AND MUST NOT 新增任何寫入類 Tool

### Requirement: 多調用方、互斥與讀取稽核
CCR 與 Codex MUST 只經 adapter 調用 Qwen，參數遵循相同 ADAPTER_LAUNCH_PATTERN；失敗不得改用直接 qwen。Qwen plan 隔離與唯讀邊界不變，不增加 Write／Edit／Shell 或 Pass 2。

#### Scenario: 同 change 並行啟動
- WHEN adapter 在讀取 CurrentState 前以 wx 取得 review.lock（pid/startedAt/runId/artifactId）
- THEN 第二個啟動 MUST 回報 review_lock_held，不寫 artifact、不刪另一個 lock
- AND 持鎖者 MUST 在 finally 釋放；stale lock 由人工確認清除

#### Scenario: 讀取違規
- WHEN stream-json 路徑指向 .env*、Master 授權容器、其他 change Runtime、workspace 外、node_modules／dist／build／coverage 或 Git ignored 檔案
- THEN evidence gate MUST 回報 read_scope_violation，effective verdict 為 INCOMPLETE
- AND 本 change Runtime 只可讀取 latestArtifactRefs／requiredInputRefs 明確引用者
- AND current-state.json realpath MUST 位於 workspace 內

#### Scenario: 讀取範圍不可證明
- WHEN 參數未知／型別錯誤、Git ignore 驗證失敗、路徑含 wildcard，或目錄搜尋未符合下列放行條件
- THEN MUST 回報 read_scope_not_proven，effective verdict 為 INCOMPLETE
- AND observed.readPaths 僅保存相對路徑，secret／外部路徑遮蔽，不保存內容

#### Scenario: 目錄搜尋放行
- GIVEN 所有 Qwen settings 層級都可解析，且沒有關閉 context.fileFiltering.respectGitIgnore 或 tools.useRipgrep
- WHEN grep_search 或 glob 搜尋 workspace 內未被禁止的目錄，或省略 path（視為 workspace 根目錄）
- THEN MUST NOT 僅因目標是目錄而回報 read_scope_not_proven
- AND 篩選條件指向 .env*、.agent-runtime、node_modules／dist／build／coverage／.git、`..` 或絕對路徑時 MUST 回報 read_scope_violation

#### Scenario: 唯讀工具清單
- WHEN 工具為 web_search、websearch、read_mcp_resource，或 Qwen 0.25.3 不提供的 read_many_files
- THEN MUST 回報 tool_readonly_not_proven，不通過 evidence gate

#### Scenario: Qwen 版本
- GIVEN adapter 的 stream-json 解析與工具契約依 Qwen 0.25.3 查證
- WHEN stream-json 回報的版本不是 0.25.3
- THEN MUST 回報 qwen_version_unverified，effective verdict 為 INCOMPLETE

#### Scenario: Windows 啟動
- GIVEN 平台為 Windows，且啟動命令為 qwen
- WHEN adapter 啟動 Qwen
- THEN MUST 不經 shell，解析為 node 與 cli-entry.js
- AND QWEN_CLI_ENTRY 有設定時 MUST 為唯一候選
- AND 找不到可讀的 cli-entry.js 時 MUST 讓啟動失敗，並在 capture 記錄 spawnError
