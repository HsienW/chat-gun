import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it, vi } from "vitest";

import { hashBusinessEffectKey } from "../side-effect/identity.js";
import { RunSequenceAllocator } from "../event-sequence.js";
import type { SideEffectReconciler } from "../side-effect/side-effect-descriptor.js";
import {
  createConversationRecovery,
  type DurableRecoveryEvidence,
} from "./conversation-recovery.js";
import { createExecutionManifestRef } from "./execution-manifest.js";
import { createLangGraphCheckpointAdapter } from "./langgraph-checkpoint-adapter.js";
import type { InterruptManifestRepository } from "./interrupt-manifest-repository.js";
import {
  parseDurableInterruptManifest,
  type DurableInterruptManifest,
} from "./interrupt-manifest.js";
import { createResumeResponseSchemaRegistry } from "./resume-response-schema-registry.js";

const executionManifest = createExecutionManifestRef({
  graphId: "recovery_integration",
  graphConfig: {
    nodes: ["await_user"],
    edges: ["start:await_user", "await_user:end"],
    checkpointer: "memory_saver",
  },
});

class InMemoryManifestRepository implements InterruptManifestRepository {
  readonly manifests = new Map<string, DurableInterruptManifest>();

  async create(manifest: DurableInterruptManifest) {
    this.manifests.set(manifest.interruptId, manifest);
    return manifest;
  }

  async findByInterruptId(interruptId: string) {
    return this.manifests.get(interruptId) ?? null;
  }

  async consume(input: {
    interruptId: string;
    runId: string;
    taskId: string;
    scopeId: string;
    now?: Date;
  }) {
    const manifest = this.manifests.get(input.interruptId);
    const now = input.now ?? new Date();
    if (
      !manifest ||
      manifest.status !== "waiting" ||
      manifest.runId !== input.runId ||
      manifest.taskId !== input.taskId ||
      manifest.scopeId !== input.scopeId ||
      new Date(manifest.expiryAt).getTime() <= now.getTime()
    ) {
      return null;
    }
    const consumed = {
      ...manifest,
      status: "resumed" as const,
      updatedAt: now.toISOString(),
    };
    this.manifests.set(input.interruptId, consumed);
    return consumed;
  }

  async transitionStatus(input: {
    interruptId: string;
    expectedStatus: DurableInterruptManifest["status"];
    nextStatus: DurableInterruptManifest["status"];
    now?: Date;
  }) {
    const manifest = this.manifests.get(input.interruptId);
    if (!manifest || manifest.status !== input.expectedStatus) return null;
    const transitioned = {
      ...manifest,
      status: input.nextStatus,
      updatedAt: (input.now ?? new Date()).toISOString(),
    };
    this.manifests.set(input.interruptId, transitioned);
    return transitioned;
  }
}

function createManifest(input: {
  interruptId: string;
  threadId: string;
  taskId: string;
  status?: DurableInterruptManifest["status"];
}) {
  return parseDurableInterruptManifest({
    interruptId: input.interruptId,
    kind: "clarification",
    runId: `run-${input.taskId}`,
    threadId: input.threadId,
    taskId: input.taskId,
    scopeId: "tenant-1",
    expectedResponseSchemaRef: "weather_clarification_resume@1.0",
    expiryAt: "2099-01-01T00:00:00.000Z",
    executionManifest,
    status: input.status ?? "waiting",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  });
}

function createCheckpointGraph(interruptId: string) {
  const RecoveryState = Annotation.Root({
    messages: Annotation<Array<Record<string, unknown>>>({
      reducer: (_left, right) => right,
      default: () => [],
    }),
  });
  return new StateGraph(RecoveryState)
    .addNode("await_user", (state) => {
      const response = interrupt({ interruptId, kind: "clarification" });
      return {
        messages: [
          ...state.messages,
          { id: `resume-${interruptId}`, role: "user", content: response },
        ],
      };
    })
    .addEdge(START, "await_user")
    .addEdge("await_user", END)
    .compile({ checkpointer: new MemorySaver() });
}

const baseEvidence: DurableRecoveryEvidence = {
  taskStatus: "waiting_confirmation",
  stepStatus: "waiting_confirmation",
  ledgerStatus: "none",
  isMutation: false,
  canRetry: false,
  reconciliationInput: {
    toolExecutionId: "execution-1",
    businessEffectKey: hashBusinessEffectKey("tenant-1:weather:1"),
  },
};

function createEventSequence(maxPersistedSequence = 0) {
  return {
    allocator: new RunSequenceAllocator(),
    readMaxPersistedSequence: vi.fn(async () => maxPersistedSequence),
  };
}

describe("conversation recovery with a real LangGraph checkpoint", () => {
  it("sanitizes checkpoint history, resumes once, reconciles mutations, and stays terminal", async () => {
    const repository = new InMemoryManifestRepository();
    const evidence = new Map<string, DurableRecoveryEvidence>();
    const reconciler: SideEffectReconciler = {
      reconcile: vi.fn(async () => ({ state: "committed" as const })),
    };
    const safeGraph = createCheckpointGraph("interrupt-safe");
    const safeAdapter = createLangGraphCheckpointAdapter({ graph: safeGraph });
    await safeGraph.invoke(
      {
        messages: [
          { id: "user-1", role: "user", content: "Taipei" },
          { id: "partial-1", role: "assistant", status: "partial" },
        ],
      },
      { configurable: { thread_id: "thread-safe" } }
    );
    await repository.create(
      createManifest({
        interruptId: "interrupt-safe",
        threadId: "thread-safe",
        taskId: "task-safe",
      })
    );
    evidence.set("task-safe", baseEvidence);

    const eventSequence = createEventSequence(41);
    const recovery = createConversationRecovery({
      checkpoint: safeAdapter,
      manifests: repository,
      responseSchemas: createResumeResponseSchemaRegistry(),
      currentExecutionManifest: executionManifest,
      loadDurableEvidence: async (taskId) => {
        const value = evidence.get(taskId);
        if (!value) throw new Error("missing evidence");
        return value;
      },
      resolveReconciler: () => reconciler,
      eventSequence,
    });

    const resumed = await recovery.recover({
      interruptId: "interrupt-safe",
      threadId: "thread-safe",
      runId: "run-task-safe",
      taskId: "task-safe",
      scopeId: "tenant-1",
      response: { userReply: "Taipei City" },
    });
    expect(resumed).toMatchObject({
      status: "resumed",
      classification: "waiting_user",
      sanitizeStatus: "sanitized",
    });
    expect(repository.manifests.get("interrupt-safe")?.status).toBe("resumed");
    expect(eventSequence.readMaxPersistedSequence).toHaveBeenCalledWith(
      "run-task-safe"
    );
    expect(eventSequence.allocator.next("run-task-safe")).toBe(42);
    const terminalSnapshot = await safeAdapter.read("thread-safe");
    expect(terminalSnapshot.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "partial-1" })])
    );

    await expect(
      recovery.recover({
        interruptId: "interrupt-safe",
        threadId: "thread-safe",
        runId: "run-task-safe",
        taskId: "task-safe",
        scopeId: "tenant-1",
        response: { userReply: "replay" },
      })
    ).resolves.toMatchObject({
      status: "manual_intervention_required",
      reasonCodes: ["MANIFEST_NOT_WAITING"],
    });

    evidence.set("task-safe", { ...baseEvidence, taskStatus: "completed" });
    await expect(
      recovery.recover({
        interruptId: "interrupt-safe",
        threadId: "thread-safe",
        runId: "run-task-safe",
        taskId: "task-safe",
        scopeId: "tenant-1",
      })
    ).resolves.toMatchObject({ status: "terminal", classification: "terminal" });

    const reconcileGraph = createCheckpointGraph("interrupt-reconcile");
    await reconcileGraph.invoke(
      { messages: [{ id: "user-2", role: "user", content: "write" }] },
      { configurable: { thread_id: "thread-reconcile" } }
    );
    await repository.create(
      createManifest({
        interruptId: "interrupt-reconcile",
        threadId: "thread-reconcile",
        taskId: "task-reconcile",
        status: "resumed",
      })
    );
    evidence.set("task-reconcile", {
      ...baseEvidence,
      taskStatus: "running",
      stepStatus: "running",
      ledgerStatus: "committed",
      isMutation: true,
    });
    const reconcileRecovery = createConversationRecovery({
      checkpoint: createLangGraphCheckpointAdapter({ graph: reconcileGraph }),
      manifests: repository,
      responseSchemas: createResumeResponseSchemaRegistry(),
      currentExecutionManifest: executionManifest,
      loadDurableEvidence: async (taskId) => evidence.get(taskId) ?? baseEvidence,
      resolveReconciler: () => reconciler,
      eventSequence: createEventSequence(),
    });
    await expect(
      reconcileRecovery.recover({
        interruptId: "interrupt-reconcile",
        threadId: "thread-reconcile",
        runId: "run-task-reconcile",
        taskId: "task-reconcile",
        scopeId: "tenant-1",
      })
    ).resolves.toMatchObject({
      status: "reconciled",
      classification: "committed",
      action: "commit",
    });
    expect(reconciler.reconcile).toHaveBeenCalledOnce();
  });

  it("parks an unprovable checkpoint without consuming or resuming", async () => {
    const repository = new InMemoryManifestRepository();
    const graph = createCheckpointGraph("interrupt-parked");
    const adapter = createLangGraphCheckpointAdapter({ graph });
    await graph.invoke(
      {
        messages: [{
          id: "assistant-1",
          role: "assistant",
          toolCalls: [{ id: "call-1", name: "write", argumentState: "incomplete" }],
        }],
      },
      { configurable: { thread_id: "thread-parked" } }
    );
    await repository.create(
      createManifest({
        interruptId: "interrupt-parked",
        threadId: "thread-parked",
        taskId: "task-parked",
      })
    );
    const recovery = createConversationRecovery({
      checkpoint: adapter,
      manifests: repository,
      responseSchemas: createResumeResponseSchemaRegistry(),
      currentExecutionManifest: executionManifest,
      loadDurableEvidence: async () => baseEvidence,
      eventSequence: createEventSequence(),
    });

    await expect(
      recovery.recover({
        interruptId: "interrupt-parked",
        threadId: "thread-parked",
        runId: "run-task-parked",
        taskId: "task-parked",
        scopeId: "tenant-1",
        response: "continue",
      })
    ).resolves.toMatchObject({
      status: "manual_intervention_required",
      reasonCodes: ["INCOMPLETE_TOOL_ARGUMENTS", "UNMATCHED_TOOL_CALL"],
    });
    expect(repository.manifests.get("interrupt-parked")?.status).toBe("waiting");
    expect((await adapter.read("thread-parked")).hasPendingNodes).toBe(true);
  });
});
