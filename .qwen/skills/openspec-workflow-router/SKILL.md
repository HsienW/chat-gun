---
name: openspec-workflow-router
description: MUST be considered at task start in this repository to detect OpenSpec change lifecycle work and route Qwen Code review tasks without loading unnecessary context. Use for proposal, design, tasks, implementation-result, fix-result, readiness, archive, or CCR/Codex/Qwen handoff review.
---

# OpenSpec Workflow Router

Use this skill as Qwen Code's read-only routing layer for the repository OpenSpec multi-agent workflow.

## Task-Start Awareness

At the start of every task in this repository:

1. Decide whether the request belongs to the OpenSpec change lifecycle.
2. If a change name is known, read only `.agent-runtime/<change-id>/current-state.json`.
3. Treat `currentPhase` as the source of truth and verify `currentOwner` is `Qwen` for review work.
4. Select exactly one stage and read the matching canonical Codex reference.
5. Read only `latestArtifactRefs` and current Handoff `requiredInputRefs`; validate changeId/runId, safe paths, existence, and absence of Secrets.
6. For review stages, load `secondary-architecture-reviewer`.
7. If CurrentState or required evidence is missing, output `INCOMPLETE`; never initialize or modify state.
8. If it is not a lifecycle task, keep the context policy below in force and continue with `QWEN.md`.
9. Before every write-capable action, verify the active role. A Reviewer must fail closed and emit only findings or a Handoff, even when the parent Qwen session retains `auto-edit`.

## Context Policy

- Prefer user-provided summaries, diffs, verification results, and named files.
- Read the minimum relevant OpenSpec artifacts and adjacent code/tests.
- Do not scan the whole repo by default.
- Ignore files and directories ignored by `.gitignore`, `node_modules/`, `dist/`, `build/`, `coverage/`, and lockfiles unless dependency changes are in scope.
- Expand context only for contract conflicts, security concerns, unclear architecture, or test failures that cannot be localized.
- Keep all user-facing output in Traditional Chinese.
- Maintain Qwen's read-only boundary from `QWEN.md`.
- Parent-session tool capability never grants the Reviewer role write authority.
- Never recursively scan `.agent-runtime/`, read another Change/Run, or write Runtime Artifacts.

## Route Table

| User intent | Stage | Qwen action |
| --- | --- | --- |
| Create or evaluate a new change plan | `plan-change` | Review capability boundary only if asked; otherwise ask CCR to plan. |
| Review proposal / design / tasks before implementation | `review-plan` | Use `secondary-architecture-reviewer` on OpenSpec artifacts. |
| Implement an approved OpenSpec change | `apply-change` | Do not implement; ask Codex to use apply-change. |
| Review Codex implementation result | `review-result` | Use `secondary-architecture-reviewer` on diff, artifacts, and validation evidence. |
| Fix issues from Qwen review | `fix-from-review` | Do not edit; provide findings and minimum fix direction. |
| Decide whether a change is ready to archive | `readiness-check` | Provide read-only residual-risk and verification assessment if asked. |
| Archive the change and draft commit message | `archive-change` | Do not archive; review readiness or ask Codex/human to archive. |

## How To Use

1. Identify the stage from the user request.
2. Read only the artifacts needed for that stage.
3. Follow `QWEN.md` and `.qwen/skills/secondary-architecture-reviewer/SKILL.md` for reviewer output.
4. If the stage is ambiguous, ask one concise Traditional Chinese question.

For review stages, emit a schema-valid `review_result` to stdout. Human or CLIHost validation and persistence must complete before CurrentState advances.

## 多調用方讀取邊界
CCR 與 Codex 均只能透過 qwen-capture-adapter 調用 Qwen。Qwen 不得讀取 Master 授權容器、.env*、其他 change Runtime 或 workspace 外路徑；本 change Runtime 只可讀取明確引用者。read_scope_violation／read_scope_not_proven 使 effective verdict 為 INCOMPLETE。不得寫入任何結果或繞過 review.lock。
