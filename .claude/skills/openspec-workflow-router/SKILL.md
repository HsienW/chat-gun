---
name: openspec-workflow-router
description: MUST be considered at task start in this repository to detect OpenSpec change lifecycle work and route Claude Code/CCR coordination tasks without loading unnecessary context. Use for planning, proposal/design/tasks review, implementation handoff, result review coordination, readiness checks, archive decisions, and CCR/Codex/Qwen handoffs.
---

# OpenSpec Workflow Router

Use this skill as Claude Code/CCR's coordination routing layer for the repository OpenSpec multi-agent workflow.

## Task-Start Awareness

At the start of every task in this repository:

1. Decide whether the request belongs to the OpenSpec change lifecycle.
2. If a change name is known, read only `.agent-runtime/<change-id>/current-state.json`.
3. During `plan-change`, initialize CurrentState when absent; otherwise treat `currentPhase` as the source of truth.
4. Select exactly one stage and read only its reference.
5. Read only `latestArtifactRefs` and current Handoff `requiredInputRefs`; validate changeId/runId, safe paths, existence, and absence of Secrets.
6. If another host owns the stage, produce the handoff and evidence list, then update CurrentState only after output persistence.
7. If it is not a lifecycle task, keep the context policy below in force and continue with `CLAUDE.md`.
8. Before every write-capable tool call, verify CCR owns the role, phase, target path, and Handoff. If any check fails, emit only the Handoff and do not modify anything.

## Context Policy

- Prefer user-provided summaries, diffs, verification results, and named files.
- Read the minimum relevant OpenSpec artifacts and adjacent code/tests.
- Do not scan the whole repo by default.
- Ignore files and directories ignored by `.gitignore`, `node_modules/`, `dist/`, `build/`, `coverage/`, and lockfiles unless dependency changes are in scope.
- Expand context only for contract conflicts, security concerns, unclear architecture, or test failures that cannot be localized.
- Keep all user-facing output in Traditional Chinese.
- Preserve Claude/CCR's coordinator role from `CLAUDE.md`.
- Tool availability, change size, and user approval of a decision do not grant CCR implementation authority. Under `rolePolicyVersion: "2"`, only a valid Master authorization (`.agent-runtime/master-authorization.json`, `grants` containing `secondary_takeover`, matching changeId/runId/handoffId, unexpired) lets CCR act as `implementation_secondary`, and only within `writeScope`.
- CCR must never accept (readiness-check or final acceptance) an implementation it produced, unless the same authorization also grants `self_acceptance` for the current task.
- Master authorization is a schemaVersion 2 container keyed by authorizationId. Select the exact Handoff authorizationRef (`master-authorization.json#<id>`), validate the entire container, and check identity, owner, active status, expiry and scope. Never union scopes; overlapping active grants reject the write. Agents must never execute master-auth-gc or delete keys. self_acceptance inputRefs must preserve authorizationId and authorizationSnapshot (canonical normalizedJson plus SHA-256).
- CCR and Codex may invoke Qwen only through the adapter with Qwen owner and review phase. Never bypass a lock/schema/evidence failure by invoking qwen directly.
- Never recursively scan `.agent-runtime/` or read another Change/Run.

## Route Table

| User intent | Stage | Claude/CCR action |
| --- | --- | --- |
| Create or evaluate a new change plan | `plan-change` | Clarify capability boundary and draft proposal/design/tasks. |
| Review proposal / design / tasks before implementation | `review-plan` | Coordinate implementability and independent architecture review. |
| Implement an approved OpenSpec change | `apply-change` | Handoff to Codex with change name, artifacts, constraints, and verification expectations. |
| Review Codex implementation result | `review-result` | Handoff to Qwen for independent read-only review, then aggregate findings. |
| Fix issues from Qwen review | `fix-from-review` | Handoff confirmed findings to Codex and preserve severity/evidence. |
| Decide whether a change is ready to archive | `readiness-check` | Check tasks, requirements, validation, residual risk, and unresolved findings. |
| Archive the change and draft commit message | `archive-change` | Approve archive when ready; git commit/push remains human-owned. |

## How To Use

1. Identify the stage from the user request.
2. Read only the artifacts needed for that stage.
3. Follow `CLAUDE.md` for coordination, arbitration, and final acceptance.
4. If the stage is ambiguous, ask one concise Traditional Chinese question.

The matching Codex reference is the canonical stage contract. Claude references add only CCR initialization, arbitration, persistence, and state-update responsibilities.
