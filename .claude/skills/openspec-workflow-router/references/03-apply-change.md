# 03 Apply Change（CCR Handoff）

- **Input**：已核准 OpenSpec、coordinatorResult、CurrentState。
- **Output**：交給 Codex 的 Handoff，列明 implementationResult 與 Evidence 路徑。
- **State Transition**：`PLAN_APPROVED` → `READY_FOR_IMPLEMENTATION`，owner → Codex。
- **CCR 責任**：確認 proposalApproved、無 blockers。預設不代替 Codex 實作；`rolePolicyVersion: "2"` 且有有效 Master `secondary_takeover` 授權時，CCR 以 `implementation_secondary` 承接，依 `.codex/skills/openspec-workflow-router/references/03-apply-change.md` 的 Artifact Contract 產出 implementation_result（producer 為 CCR），只寫 `writeScope` 內的路徑。
