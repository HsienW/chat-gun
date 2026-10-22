# 01 Plan Change

Use this prompt when a requirement is not yet formalized as an OpenSpec change.

```text
請以 CCR / OpenSpec planning coordinator 身分，為下列需求建立精簡 OpenSpec change 計劃。

需求：
{change_summary}

請不要實作程式碼。請優先讀取：

- AGENTS.md 中與 OpenSpec / change 流程相關的片段。
- openspec/config.yaml。
- 直接相關的既有 specs / active changes。
- 使用者指出的檔案或能力域。

除非必要，不要掃描整個 repo。忽略 `.gitignore` 內文件、node_modules、dist、build、coverage、lockfile。

請輸出：

## Change Name 建議
## 需求理解
## 受影響範圍
## 規格疑問
## Proposal 草案
## Design 草案
## Tasks 草案
## 驗證計畫
## 風險

要求：

- Tasks 必須可驗證。
- 若涉及解析、分類、tool、provider 或 planner，不得用 hard-coded mapping、keyword shortcut 或特殊案例分支作為核心方案。
- 若需求與既有規則或契約衝突，請停止並明確指出。
- 請使用繁體中文。
```

## Artifact Contract

- **Input**：目前 Change 的 CurrentState；不存在時只有 CCR 可初始化，或在 `rolePolicyVersion: "2"` 下持有有效 Master 授權的 Codex（planning_secondary）可初始化。
- **Output**：proposal/design/tasks、`artifacts/coordinator-result.json`、`artifacts/handoff.json`。
- **State Transition**：`PLAN_DRAFT` → `PLAN_REVIEW`，owner → Qwen。
- **Validation**：Result／Handoff 通過 Schema，References 使用安全相對路徑。
