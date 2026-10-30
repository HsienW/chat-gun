# 06 Readiness Check

Use this prompt when CCR should decide whether a change can enter archive.

```text
請以 CCR / OpenSpec flow coordinator 身分，判定 change 是否可進入 archive。

Change：
{change_name}

Codex 最終摘要：
{change_summary}

Qwen review 結論：
{review_findings}

驗證結果：
{verification_results}

請只做流程判定，不修改 application code。優先讀取：

- openspec/changes/{change_name}/proposal.md
- openspec/changes/{change_name}/design.md
- openspec/changes/{change_name}/tasks.md
- openspec/changes/{change_name}/specs/
- Qwen verdict
- 驗證結果
- git diff 檔案清單與摘要

不要重掃整個 repo。忽略 `.gitignore` 內文件、node_modules、dist、build、coverage。預設忽略 lockfile；若 diff 顯示 dependency 變更才讀取。

請檢查：

- Requirement / Scenario / Task 是否一致。
- 已勾選 task 是否都有實作與驗證。
- 是否仍有 Blocker / Major。
- 是否有宣稱但未執行的驗證。
- Diff 是否只包含本 change 相關檔案。

輸出：

## 完成判定

- READY_TO_ARCHIVE
- NOT_READY

## 判定理由
## 已完成 Tasks
## 驗證核對
## 尚未處理事項
## Archive 前建議

請使用繁體中文。
```

## Artifact Contract

- **Input**：CurrentState、implementationResult、reviewResult、Evidence 與 OpenSpec；不要求長摘要。
- **Output**：`artifacts/readiness-result.json` 與 archive-change Handoff。
- **State Transition**：`READY_FOR_READINESS_CHECK` → `READY_FOR_ARCHIVE`；需修正時 → `IMPLEMENTING`／Codex。
- **Validation**：前三個 Gate 為 true、blockers 為空且 Requirements 有證據後，CCR 才可設定 readinessConfirmed。

## 授權快照 Gate
驗收者不得是 implementation_result 的 producer，除非依 Handoff 的 master-authorization.json#<id> 精準取得當次有效 self_acceptance 授權。inputRefs 使用 .agent-runtime/master-authorization.json 作為 relativePath，另帶 authorizationId 與 authorizationSnapshot（相同 ID、normalizedJson、sha256）。用 tools/master-authorization.mjs 的 authorizationSnapshot／verifyAuthorizationSnapshot 產生及核對。快照保留稽核，不取代 live 授權；不得聯集 scope 或執行 GC。
