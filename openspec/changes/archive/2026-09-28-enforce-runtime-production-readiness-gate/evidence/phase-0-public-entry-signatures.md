# Phase 0 public entry signatures

Change: `enforce-runtime-production-readiness-gate`
Run: `run-2026-09-28-x21-001`

## Archived dependencies

The archive inventory contains the X10.2 and X11-X20 changes required by this change, including:

- `2026-09-15-add-runtime-operations-slo-eval-release-gate`
- `2026-09-19-reverify-current-langgraph-runtime-boundary`
- `2026-09-20-add-canonical-execution-context`
- `2026-09-24-wire-trusted-identity-authorization-hitl`
- `2026-09-23-establish-unified-tool-dispatch-pipeline`
- `2026-09-24-harden-provider-and-tool-call-decoding`
- `2026-09-25-add-tool-scheduling-and-resilience-policy`
- `2026-09-26-establish-normalized-input-and-query-guard`
- `2026-09-26-activate-context-budget-compression-memory`
- `2026-09-27-version-runtime-event-and-terminal-contract`
- `2026-09-28-add-durable-hitl-and-conversation-recovery`

## Existing canary gap

`backend/src/operations/canary.ts` exposes `CanaryDependencies` with nine injected operations (`createTask`, `createStep`, `persistTaskStepEvent`, `invokeSafeMockTool`, `checkpointAndInterrupt`, `resumeFromCheckpoint`, `verifyAuditAndTrace`, `cleanup`, and `markDeploymentHealth`). `runLiveRuntimeCanary()` only invokes those abstractions and does not import or call X12, X14, X18, X19, or X20 public entries. This is the reproducible pre-change evidence for Phase 8.

## Importable public entries

| Capability | Module | Public entry/signature used by X21 |
|---|---|---|
| X12 canonical context | `backend/src/runtime/execution-context/read-execution-context.ts` | `readExecutionContext(input: unknown, config: unknown, environment?: ExecutionEnvironment): ExecutionContext` |
| X17 normalized input | `backend/src/runtime/input/read-normalized-agent-input.ts` | `readNormalizedAgentInput(rawInput: unknown, config?: unknown): ReadNormalizedAgentInputResult` |
| X18 governed context | `backend/src/context/context-assembler.ts` | `assembleFromItems(items: readonly ContextItem[], config?: ContextAssemblerConfig): AssembledContext` |
| X14 unified dispatch | `backend/src/runtime/tool-dispatch/pipeline.ts` | `createRuntimeToolDispatchPipeline(input: RuntimeToolDispatchPipelineDependencies): RuntimeToolDispatchPipeline`; `RuntimeToolDispatchPipeline.createExecutor(toolName, sourceExecutor)` |
| X19 event envelope | `backend/src/runtime/event-envelope.ts` | `projectExecutionEventContext(context: ExecutionContext): ExecutionEventContext`; `runtimeEventEnvelopeSchema`; `parseRuntimeEventEnvelope(value: unknown)` |
| X19 event identity/sequence | `backend/src/runtime/event-sequence.ts` | `RunSequenceAllocator`; `stableEventId(...)` |
| X20 recovery sanitizer | `backend/src/runtime/recovery/recovery-sanitizer.ts` | `sanitizeRecoveryHistory(input: SanitizeRecoveryHistoryInput): SanitizeResult` |
| X20 recovery orchestration | `backend/src/runtime/recovery/conversation-recovery.ts` | `createConversationRecovery(dependencies: ConversationRecoveryDependencies)` |

All mandatory public entries are importable. Phase 0 therefore passes without modifying the X12-X20 contracts.
