# 05 Fix From Review

Use this prompt when Codex should fix Qwen review findings.

```text
請以 Codex coding agent 身分，依 Qwen review 結論修正 OpenSpec change：

{change_name}

Qwen findings：
{review_findings}

請只讀取必要上下文：

- Qwen findings 指到的檔案與相鄰上下文。
- 相關 OpenSpec Requirement / Task。
- 必要測試檔案。
- 必要 AGENTS.md 規則片段。

不要重掃整個 repo。忽略 `.gitignore` 內文件、node_modules、dist、build、coverage。預設忽略 lockfile；若本 finding 涉及 dependency 變更才讀取。

若 finding 與 OpenSpec 或專案規則衝突，先停止回報。

修正要求：

- 僅處理 Qwen findings 與必要相鄰測試。
- 不混入無關重構。
- 若 finding 是誤判，請用程式碼與契約證據說明。
- 修正後執行對應測試與必要回歸。
- 實際通過後才更新 tasks.md。

完成後輸出：

## 完成內容
## 修改檔案
## 對應 Findings
## 測試與驗證結果
## 尚未處理事項
## 相容性與風險

請使用繁體中文。
```

## Artifact Contract

- **Input**：CurrentState 最新 reviewResult、implementationResult、OpenSpec 與 Evidence；不要求重貼 Findings。
- **Output**：覆蓋 latest implementation-result、更新 Evidence 與 review-result Handoff。
- **State Transition**：`CHANGES_REQUESTED` → `IMPLEMENTING` → `READY_FOR_REVIEW`；衝突時 → `NEEDS_COORDINATOR_ARBITRATION`。
- **Validation**：只修正 artifact 中確認的 Findings；每輪 `attempt` 遞增並遵守停止線。
- **承接者**：預設為 Codex；`rolePolicyVersion: "2"` 下可能是持有 Master 授權的 CCR（implementation_secondary），契約相同，producer 記為實際執行者。
