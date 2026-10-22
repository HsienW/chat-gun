# 06 Readiness Check（CCR）

- **Input**：CurrentState、implementationResult、reviewResult、Evidence、OpenSpec。
- **Output**：readiness_result 與 archive-change Handoff。
- **State Transition**：`READY_FOR_READINESS_CHECK` → `READY_FOR_ARCHIVE` 或 `IMPLEMENTING`。
- **CCR 責任**：核對 Gate、blockers、Tasks 與 Requirement evidence，不依長摘要判定。
- **撰寫者驗收 Gate**：最新 implementation_result 的 producer 為 CCR 時，CCR 不得產出 readiness_result，除非 Master 授權 `self_acceptance` 涵蓋當次任務且 readiness_result 引用該授權；否則交由 Master 或經授權的 Codex（planning_secondary）執行。
