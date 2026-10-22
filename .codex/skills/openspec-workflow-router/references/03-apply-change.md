# 03 Apply Change

Use this prompt when an approved OpenSpec change should be implemented by Codex.

```text
請以 Codex coding agent 身分實作 OpenSpec change：

{change_name}

請先讀取最小必要上下文：

- AGENTS.md。
- 受影響套件的 AGENTS.md。
- openspec/config.yaml。
- openspec/changes/{change_name}/proposal.md。
- openspec/changes/{change_name}/design.md。
- openspec/changes/{change_name}/tasks.md。
- openspec/changes/{change_name}/specs/。
- 直接受影響的程式碼與測試。

不要重掃整個 repo。忽略 `.gitignore` 內文件、node_modules、dist、build、coverage。預設忽略 lockfile；若本 change 涉及 dependency 變更才讀取。

只有在遇到契約不明、跨層衝突或測試失敗無法定位時，才擴大讀取範圍。

執行要求：

- 僅實作 OpenSpec scope 內必要變更。
- 不混入無關重構、重新命名、格式化或套件升級。
- 若涉及解析、分類、tool、provider 或 planner，不用 hard-coded mapping、keyword shortcut、特殊案例分支繞過 schema / resolver / provider。
- 修改後執行受影響套件驗證。
- 實際通過後才更新 tasks.md。

完成後輸出：

## 完成內容
## 修改檔案
## 對應 Tasks
## 測試與驗證結果
## 尚未處理事項
## 相容性與風險

請如實列出未執行或失敗的驗證。請使用繁體中文。
```

## Artifact Contract

- **Input**：CurrentState 的 proposal/design/tasks/coordinatorResult 與 apply-change Handoff。
- **Output**：`artifacts/implementation-result.json`、`artifacts/handoff.json`、`evidence/changed-files.txt`、`git-diff.patch`、`git-diff-stat.txt`、`git-diff-check.txt`、`validation-summary.json`；適用時另存 lint/test/build 輸出。
- **State Transition**：開始時 `READY_FOR_IMPLEMENTATION` → `IMPLEMENTING`；成功時 → `READY_FOR_REVIEW` 且 owner → Qwen；根本規格問題時回到 `PLAN_DRAFT`／CCR。
- **Validation**：Evidence 只記錄實際命令；未執行項目列入 `notExecuted`。更新 CurrentState 前驗證 Result、Handoff 與所有 References。
- **承接者**：預設為 Codex；`rolePolicyVersion: "2"` 下可能是持有 Master 授權的 CCR（implementation_secondary），契約相同，producer 記為實際執行者。
