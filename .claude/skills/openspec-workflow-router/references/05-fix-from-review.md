# 05 Fix From Review（CCR Handoff）

- **Input**：最新 reviewResult、implementationResult、OpenSpec 與 Evidence。
- **Output**：交給 Codex 的 fix Handoff，列出 references 與接受條件。
- **State Transition**：`CHANGES_REQUESTED` → `IMPLEMENTING`；衝突時 → `NEEDS_COORDINATOR_ARBITRATION`。
- **CCR 責任**：保留 Finding severity/evidence，只在衝突時仲裁。CCR 是本次實作者時，仲裁改由 Master 或經授權的 Codex 完成；修正工作只有在 v2 且有有效 Master 授權時，CCR 才能以 `implementation_secondary` 承接。
