import { describe, expect, it, vi } from "vitest";

import type { ActiveRunOwnership } from "../runtime/interaction/ownership.js";
import type { InputClassificationResult } from "../runtime/interaction/classify.js";
import type { InteractionTaskEvent } from "../runtime/interaction/events.js";
import {
  applyInteractionGovernance,
  createInteractionOrchestrator,
  createProductionInteractionOrchestrator,
  InteractionGovernanceRejectedError,
  type InteractionOrchestrator,
  type InteractionOrchestratorConfig,
} from "./interaction-runtime.js";

const STREAM_METHOD_NAMES = ["stream", "streamEvents", "streamLog"] as const;

function createTestStream(chunk: unknown): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield chunk;
    },
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      Symbol.asyncIterator in value &&
      typeof value[Symbol.asyncIterator] === "function"
  );
}

async function consumeTestStream(value: unknown): Promise<unknown[]> {
  if (!isAsyncIterable(value)) {
    throw new TypeError("Expected an AsyncIterable test stream");
  }

  const chunks: unknown[] = [];
  for await (const chunk of value) chunks.push(chunk);
  return chunks;
}

const configuredPolicy = (strategy: "reject" | "enqueue" | "supersede") =>
  JSON.stringify({
    strategy,
    clarificationReplyMode: "new_task",
    cancellationMode: "cancel_if_read_only",
    allowIntentRevision: true,
  });

const finalRevision: InputClassificationResult = {
  status: "final",
  classification: "intent_revision",
  confidence: "deterministic",
  reasonCode: "CONFIRMED_REVISION",
  inputDigest: "a".repeat(64),
  inputByteLength: 12,
};

function ownership(input: Partial<ActiveRunOwnership> = {}): ActiveRunOwnership {
  return {
    threadId: "thread-1",
    scopeId: "scope-1",
    taskId: "task-1",
    runId: "run-1",
    status: "active",
    generation: 3,
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...input,
  };
}

function runConfig(runId = "run-2") {
  return {
    runId,
    configurable: {
      thread_id: "thread-1",
      scope_id: "scope-1",
      task_id: `task-${runId}`,
      "x-request-id": "request-2",
      "x-idempotency-key": "idempotency-2",
      "x-active-run-id": "client-stale-run",
      "x-active-run-generation": "99",
    },
  };
}

function trustedRunConfig(runId = "run-2") {
  return {
    runId,
    configurable: {
      thread_id: "thread-1",
      scope_id: "scope-1",
      task_id: `task-${runId}`,
      "x-request-id": "request-2",
      "x-idempotency-key": "a".repeat(64),
      "x-bff-idempotency-ttl-ms": "60000",
    },
  };
}

function configuredDependencies(strategy: "reject" | "enqueue" | "supersede") {
  const active = ownership();
  const replacement = ownership({
    taskId: "task-run-2",
    runId: "run-2",
    generation: 4,
  });
  const ownershipRepository = {
    findActive: vi.fn(async () => active),
    claim: vi.fn(async () => replacement),
    supersede: vi.fn(async () => replacement),
    markTerminal: vi.fn(async () => replacement),
  };
  const eventRecorder = {
    record: vi.fn(async (_event: InteractionTaskEvent) => undefined),
  };
  const recordMetric = vi.fn();
  const decideCancellation = vi.fn(async () => ({
    phase: "read_only" as const,
    path: "interrupt_or_supersede" as const,
  }));

  const config: InteractionOrchestratorConfig = {
    rawPolicy: configuredPolicy(strategy),
    ownershipRepository,
    classify: vi.fn(async () => finalRevision),
    decideCancellation,
    eventRecorder,
    ensureTask: vi.fn(async () => undefined),
    recordMetric,
  };

  return {
    config,
    ownershipRepository,
    eventRecorder,
    recordMetric,
    decideCancellation,
  };
}

describe("interaction runtime production wrapper", () => {
  it.each(STREAM_METHOD_NAMES)(
    "returns %s as an AsyncIterable before asynchronous setup starts",
    async (streamMethodName) => {
      const orchestrator: InteractionOrchestrator = {
        isConfigured: true,
        beforeRun: vi.fn(async () => ({ configured: true, events: [] })),
        afterRun: vi.fn(async () => undefined),
      };
      const graph = {
        stream: vi.fn((_input?: unknown, _config?: unknown) =>
          createTestStream("stream")
        ),
        streamEvents: vi.fn((_input?: unknown, _config?: unknown) =>
          createTestStream("streamEvents")
        ),
        streamLog: vi.fn((_input?: unknown, _config?: unknown) =>
          createTestStream("streamLog")
        ),
      };
      const governed = applyInteractionGovernance(graph, orchestrator);

      const stream = governed[streamMethodName]({}, runConfig());

      expect(stream).not.toBeInstanceOf(Promise);
      expect(orchestrator.beforeRun).not.toHaveBeenCalled();

      const chunks: unknown[] = [];
      for await (const chunk of stream) chunks.push(chunk);

      expect(chunks).toEqual([streamMethodName]);
      expect(orchestrator.afterRun).toHaveBeenCalledOnce();
    }
  );

  it("is a true no-op when no InteractionPolicy is configured", async () => {
    let markFirstStarted: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const graph = {
      invoke: vi.fn(async (input: { request: string }, config?: unknown) => {
        if (input.request === "first") {
          markFirstStarted?.();
          await firstGate;
        }
        return { input, config };
      }),
    };
    const orchestrator = createProductionInteractionOrchestrator({ rawPolicy: " " });
    const governed = applyInteractionGovernance(graph, orchestrator);

    expect(governed).toBe(graph);
    const firstRun = governed.invoke({ request: "first" }, runConfig("run-1"));
    await firstStarted;
    await expect(
      governed.invoke({ request: "second" }, runConfig("run-2"))
    ).resolves.toEqual({
      input: { request: "second" },
      config: runConfig("run-2"),
    });
    releaseFirst?.();
    await expect(firstRun).resolves.toEqual({
      input: { request: "first" },
      config: runConfig("run-1"),
    });
    expect(graph.invoke).toHaveBeenCalledTimes(2);
  });

  it("uses authoritative ownership instead of a conflicting client hint", async () => {
    const dependencies = configuredDependencies("supersede");
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({ ok: true })),
    };
    const governed = applyInteractionGovernance(
      graph,
      createInteractionOrchestrator(dependencies.config)
    );

    await expect(
      governed.invoke({ messages: ["change the request"] }, runConfig())
    ).resolves.toEqual({ ok: true });

    expect(dependencies.ownershipRepository.supersede).toHaveBeenCalledWith({
      threadId: "thread-1",
      scopeId: "scope-1",
      expectedGeneration: 3,
      replacementTaskId: "task-run-2",
      replacementRunId: "run-2",
    });
    expect(dependencies.eventRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "superseded",
        payload: expect.objectContaining({
          priorRunId: "run-1",
          replacementRunId: "run-2",
          generation: 4,
        }),
      })
    );
    expect(dependencies.recordMetric).toHaveBeenCalledWith(
      "interaction.decision",
      expect.not.objectContaining({
        threadId: expect.anything(),
        runId: expect.anything(),
        generation: expect.anything(),
      })
    );
  });

  it("rejects a replacement run when the configured policy rejects", async () => {
    const dependencies = configuredDependencies("reject");
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({ ok: true })),
    };
    const governed = applyInteractionGovernance(
      graph,
      createInteractionOrchestrator(dependencies.config)
    );

    await expect(
      governed.invoke({ messages: ["new input"] }, runConfig())
    ).rejects.toMatchObject({
      name: "InteractionGovernanceRejectedError",
      reasonCode: "POLICY_REJECTED",
    });
    expect(graph.invoke).not.toHaveBeenCalled();
    expect(dependencies.ownershipRepository.supersede).not.toHaveBeenCalled();
    expect(dependencies.eventRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cancelled",
        payload: expect.objectContaining({
          decision: expect.objectContaining({ strategy: "reject" }),
        }),
      })
    );
  });

  it("fails closed for enqueue until a native queue owns the replacement run", async () => {
    const dependencies = configuredDependencies("enqueue");
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({ ok: true })),
    };
    const governed = applyInteractionGovernance(
      graph,
      createInteractionOrchestrator(dependencies.config)
    );

    await expect(
      governed.invoke({ messages: ["new input"] }, runConfig())
    ).rejects.toMatchObject({
      name: "InteractionGovernanceRejectedError",
      reasonCode: "NATIVE_QUEUE_OWNERSHIP_REQUIRED",
    });
    expect(graph.invoke).not.toHaveBeenCalled();
    expect(dependencies.ownershipRepository.claim).not.toHaveBeenCalled();
    expect(dependencies.ownershipRepository.supersede).not.toHaveBeenCalled();
    expect(dependencies.ownershipRepository.markTerminal).toHaveBeenCalledWith({
      threadId: "thread-1",
      scopeId: "scope-1",
      runId: "run-2",
      status: "cancelled",
    });
    expect(dependencies.eventRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cancelled",
        payload: expect.objectContaining({
          priorRunId: "run-1",
          generation: 3,
          decision: {
            strategy: "enqueue",
            disposition: "native_queue_ownership_required",
            classification: "intent_revision",
            reasonCode: "NATIVE_QUEUE_OWNERSHIP_REQUIRED",
          },
        }),
      })
    );
  });

  it("preserves a beforeRun rejection without invoking terminal cleanup", async () => {
    const beforeRunError = new InteractionGovernanceRejectedError(
      "POLICY_REJECTED"
    );
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({ ok: true })),
    };
    const orchestrator: InteractionOrchestrator = {
      isConfigured: true,
      beforeRun: vi.fn(async () => {
        throw beforeRunError;
      }),
      afterRun: vi.fn(async () => undefined),
    };
    const governed = applyInteractionGovernance(graph, orchestrator);

    await expect(governed.invoke({}, runConfig())).rejects.toBe(beforeRunError);
    expect(graph.invoke).not.toHaveBeenCalled();
    expect(orchestrator.afterRun).not.toHaveBeenCalled();
  });

  it("ignores terminal cleanup when run start is unavailable", async () => {
    const dependencies = configuredDependencies("supersede");
    const orchestrator = createInteractionOrchestrator(dependencies.config);

    await expect(
      orchestrator.afterRun(undefined, "completed")
    ).resolves.toBeUndefined();
    expect(dependencies.ownershipRepository.markTerminal).not.toHaveBeenCalled();
  });

  it("emits the generation before stream chunks and marks terminal ownership", async () => {
    const dependencies = configuredDependencies("supersede");
    const graph = {
      async stream(_input: unknown, _config?: unknown) {
        return {
          async *[Symbol.asyncIterator]() {
            yield { messages: ["new answer"] };
          },
        };
      },
    };
    const governed = applyInteractionGovernance(
      graph,
      createInteractionOrchestrator(dependencies.config)
    );

    const stream = await governed.stream(
      { kind: "prompt", text: "new input" },
      runConfig(),
    );
    const chunks: unknown[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks[0]).toMatchObject({
      interaction_runtime: {
        taskEvent: {
          eventType: "superseded",
          payload: { generation: 4, replacementRunId: "run-2" },
        },
      },
    });
    expect(chunks[1]).toEqual({ messages: ["new answer"] });
    expect(dependencies.ownershipRepository.markTerminal).toHaveBeenCalledWith({
      threadId: "thread-1",
      scopeId: "scope-1",
      runId: "run-2",
      status: "completed",
    });
  });

  it("marks ownership terminal when stream setup fails", async () => {
    const dependencies = configuredDependencies("supersede");
    const graph = {
      stream: vi.fn(
        (_input: unknown, _config?: unknown): unknown =>
          Promise.reject(new Error("stream setup failed"))
      ),
    };
    const governed = applyInteractionGovernance(
      graph,
      createInteractionOrchestrator(dependencies.config)
    );

    await expect(
      consumeTestStream(
        governed.stream({ kind: "prompt", text: "new input" }, runConfig()),
      )
    ).rejects.toThrow("stream setup failed");
    expect(dependencies.ownershipRepository.markTerminal).toHaveBeenCalledWith({
      threadId: "thread-1",
      scopeId: "scope-1",
      runId: "run-2",
      status: "completed",
    });
  });

  it("does not supersede ownership when cancellation requires manual handling", async () => {
    const dependencies = configuredDependencies("supersede");
    dependencies.config.decideCancellation = vi.fn(async () => ({
      phase: "irreversible_committed" as const,
      path: "manual_intervention_required" as const,
    }));
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({ ok: true })),
    };
    const governed = applyInteractionGovernance(
      graph,
      createInteractionOrchestrator(dependencies.config)
    );

    await expect(
      governed.invoke({ kind: "prompt", text: "new input" }, runConfig()),
    ).rejects.toMatchObject({
      reasonCode: "ACTIVE_RUN_REQUIRES_CORRECTIVE_OR_MANUAL_HANDLING",
    });
    expect(dependencies.ownershipRepository.supersede).not.toHaveBeenCalled();
    expect(dependencies.eventRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "manual_intervention_required" })
    );
  });

  it("returns a completed idempotent result after terminal cleanup without dispatch", async () => {
    const dependencies = configuredDependencies("supersede");
    const order: string[] = [];
    dependencies.ownershipRepository.markTerminal.mockImplementation(async () => {
      order.push("terminal");
      return ownership({ taskId: "task-run-2", runId: "run-2", generation: 4 });
    });
    dependencies.eventRecorder.record.mockImplementation(async () => {
      order.push("event");
    });
    const queryGuard = {
      reserve: vi.fn(async () => ({
        reserved: true as const,
        ownership: ownership({
          taskId: "task-run-2",
          runId: "run-2",
          generation: 4,
        }),
      })),
      dispatch: vi.fn(async () => {
        order.push("dispatch");
      }),
      release: vi.fn(async () => undefined),
      adopt: vi.fn(),
    };
    const idempotencyGuard = {
      acquire: vi.fn(async () => ({
        acquired: false as const,
        reason: "already_completed" as const,
        existing: {
          key: "interaction_input:key:v1",
          status: "completed" as const,
          result: { cached: true },
          createdAt: "2026-09-26T00:00:00.000Z",
          expiresAt: "2026-09-26T01:00:00.000Z",
        },
      })),
      markCompleted: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      getRecord: vi.fn(async () => null),
    };
    dependencies.config.queryGuard = queryGuard;
    dependencies.config.idempotencyGuard = idempotencyGuard;
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({
        sideEffect: true,
      })),
    };
    const governed = applyInteractionGovernance(
      graph,
      createInteractionOrchestrator(dependencies.config),
    );

    await expect(
      governed.invoke({ kind: "prompt", text: "hello" }, trustedRunConfig()),
    ).resolves.toEqual({ cached: true });

    expect(graph.invoke).not.toHaveBeenCalled();
    expect(queryGuard.dispatch).not.toHaveBeenCalled();
    expect(order.slice(0, 2)).toEqual(["terminal", "event"]);
    expect(dependencies.eventRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cancelled",
        payload: expect.objectContaining({
          decision: expect.objectContaining({
            classification: "duplicate_input",
            reasonCode: "IDEMPOTENCY_KEY_COMPLETED",
          }),
        }),
      }),
    );
  });

  it("rejects a locked idempotency key after terminal cleanup without dispatch", async () => {
    const dependencies = configuredDependencies("supersede");
    const order: string[] = [];
    dependencies.ownershipRepository.markTerminal.mockImplementation(async () => {
      order.push("terminal");
      return ownership({ taskId: "task-run-2", runId: "run-2", generation: 4 });
    });
    dependencies.eventRecorder.record.mockImplementation(async () => {
      order.push("event");
    });
    const queryGuard = {
      reserve: vi.fn(async () => ({
        reserved: true as const,
        ownership: ownership({
          taskId: "task-run-2",
          runId: "run-2",
          generation: 4,
        }),
      })),
      dispatch: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      adopt: vi.fn(),
    };
    const idempotencyGuard = {
      acquire: vi.fn(async () => ({
        acquired: false as const,
        reason: "already_locked" as const,
        existing: {
          key: "interaction_input:key:v1",
          status: "locked" as const,
          createdAt: "2026-09-26T00:00:00.000Z",
          expiresAt: "2026-09-26T01:00:00.000Z",
        },
      })),
      markCompleted: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      getRecord: vi.fn(async () => null),
    };
    dependencies.config.queryGuard = queryGuard;
    dependencies.config.idempotencyGuard = idempotencyGuard;
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({
        sideEffect: true,
      })),
    };

    await expect(
      applyInteractionGovernance(
        graph,
        createInteractionOrchestrator(dependencies.config),
      ).invoke({ kind: "prompt", text: "hello" }, trustedRunConfig()),
    ).rejects.toMatchObject({ reasonCode: "IDEMPOTENCY_KEY_LOCKED" });

    expect(graph.invoke).not.toHaveBeenCalled();
    expect(queryGuard.dispatch).not.toHaveBeenCalled();
    expect(order.slice(0, 2)).toEqual(["terminal", "event"]);
  });

  it("cleans up the reservation when idempotency storage fails", async () => {
    const dependencies = configuredDependencies("supersede");
    const storageError = new Error("idempotency storage unavailable");
    const queryGuard = {
      reserve: vi.fn(async () => ({
        reserved: true as const,
        ownership: ownership({
          taskId: "task-run-2",
          runId: "run-2",
          generation: 4,
        }),
      })),
      dispatch: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      adopt: vi.fn(),
    };
    dependencies.config.queryGuard = queryGuard;
    dependencies.config.idempotencyGuard = {
      acquire: vi.fn(async () => {
        throw storageError;
      }),
      markCompleted: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({ ok: true })),
    };

    await expect(
      applyInteractionGovernance(
        graph,
        createInteractionOrchestrator(dependencies.config),
      ).invoke({ kind: "prompt", text: "hello" }, trustedRunConfig()),
    ).rejects.toBe(storageError);

    expect(dependencies.ownershipRepository.markTerminal).toHaveBeenCalledWith({
      threadId: "thread-1",
      scopeId: "scope-1",
      runId: "run-2",
      status: "cancelled",
    });
    expect(queryGuard.release).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-2" }),
      4,
    );
    expect(queryGuard.dispatch).not.toHaveBeenCalled();
    expect(graph.invoke).not.toHaveBeenCalled();
  });

  it("marks a newly acquired trusted key completed with the graph result", async () => {
    const dependencies = configuredDependencies("supersede");
    const queryGuard = {
      reserve: vi.fn(async () => ({
        reserved: true as const,
        ownership: ownership({
          taskId: "task-run-2",
          runId: "run-2",
          generation: 4,
        }),
      })),
      dispatch: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      adopt: vi.fn(),
    };
    const idempotencyGuard = {
      acquire: vi.fn(async () => ({
        acquired: true as const,
        record: {
          key: "interaction_input:key:v1",
          status: "locked" as const,
          createdAt: "2026-09-26T00:00:00.000Z",
          expiresAt: "2026-09-26T01:00:00.000Z",
        },
      })),
      markCompleted: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      getRecord: vi.fn(async () => null),
    };
    dependencies.config.queryGuard = queryGuard;
    dependencies.config.idempotencyGuard = idempotencyGuard;
    const graphResult = { ok: true };
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => graphResult),
    };

    await expect(
      applyInteractionGovernance(
        graph,
        createInteractionOrchestrator(dependencies.config),
      ).invoke({ kind: "prompt", text: "hello" }, trustedRunConfig()),
    ).resolves.toEqual(graphResult);

    expect(idempotencyGuard.markCompleted).toHaveBeenCalledWith(
      {
        namespace: "interaction_input",
        resourceKey: "a".repeat(64),
        version: "1",
      },
      graphResult,
    );
    expect(queryGuard.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-2" }),
      4,
    );
  });

  it("passes through without calling idempotency when no trusted key exists", async () => {
    const dependencies = configuredDependencies("supersede");
    const idempotencyGuard = {
      acquire: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
      getRecord: vi.fn(),
    };
    dependencies.config.idempotencyGuard = idempotencyGuard;
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({ ok: true })),
    };
    const {
      "x-idempotency-key": _ignoredIdempotencyKey,
      ...configurable
    } = runConfig().configurable;
    const config = { runId: "run-2", configurable };

    await applyInteractionGovernance(
      graph,
      createInteractionOrchestrator(dependencies.config),
    ).invoke({ kind: "prompt", text: "hello" }, config);

    expect(idempotencyGuard.acquire).not.toHaveBeenCalled();
  });

  it("rejects an unsupported command after terminal cleanup and before dispatch", async () => {
    const dependencies = configuredDependencies("supersede");
    const order: string[] = [];
    dependencies.ownershipRepository.markTerminal.mockImplementation(async () => {
      order.push("terminal");
      return ownership({ taskId: "task-run-2", runId: "run-2", generation: 4 });
    });
    dependencies.eventRecorder.record.mockImplementation(async () => {
      order.push("event");
    });
    const queryGuard = {
      reserve: vi.fn(async () => ({
        reserved: true as const,
        ownership: ownership({
          taskId: "task-run-2",
          runId: "run-2",
          generation: 4,
        }),
      })),
      dispatch: vi.fn(async () => {
        order.push("dispatch");
      }),
      release: vi.fn(async () => undefined),
      adopt: vi.fn(),
    };
    dependencies.config.queryGuard = queryGuard;
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({ ok: true })),
    };

    await expect(
      applyInteractionGovernance(
        graph,
        createInteractionOrchestrator(dependencies.config),
      ).invoke({ kind: "command", commandId: "refresh" }, runConfig()),
    ).rejects.toMatchObject({ reasonCode: "unsupported_command" });

    expect(graph.invoke).not.toHaveBeenCalled();
    expect(queryGuard.dispatch).not.toHaveBeenCalled();
    expect(order.slice(0, 2)).toEqual(["terminal", "event"]);
  });

  it("routes canonical cancel through deterministic cancellation governance", async () => {
    const dependencies = configuredDependencies("supersede");
    delete dependencies.config.classify;
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({
        cancelled: true,
      })),
    };

    await applyInteractionGovernance(
      graph,
      createInteractionOrchestrator(dependencies.config),
    ).invoke({ kind: "cancel", targetRunId: "run-1" }, runConfig());

    expect(dependencies.decideCancellation).toHaveBeenCalledOnce();
    expect(dependencies.eventRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          decision: expect.objectContaining({
            classification: "cancel_request",
            reasonCode: "EXPLICIT_CANCEL_SIGNAL",
          }),
        }),
      }),
    );
  });

  it("resumes the waiting task and emits clarification_resumed with the same interrupt id", async () => {
    const dependencies = configuredDependencies("supersede");
    dependencies.config.rawPolicy = JSON.stringify({
      strategy: "supersede",
      clarificationReplyMode: "resume_same_task",
      cancellationMode: "cancel_if_read_only",
      allowIntentRevision: true,
    });
    delete dependencies.config.classify;
    const baseConfig = runConfig();
    const config = {
      ...baseConfig,
      configurable: {
        ...baseConfig.configurable,
        clientInteractionMetadata: {
          inputKind: "clarification_resume",
        },
      },
    };
    const graph = {
      invoke: vi.fn(async (_input: unknown, _config?: unknown) => ({
        resumed: true,
      })),
    };
    const interruptId = "clarification:" + "b".repeat(64);

    await applyInteractionGovernance(
      graph,
      createInteractionOrchestrator(dependencies.config),
    ).invoke(
      {
        command: { resume: { answer: "Taipei" } },
        interruptId,
      },
      config,
    );

    expect(dependencies.ownershipRepository.supersede).toHaveBeenCalledWith({
      threadId: "thread-1",
      scopeId: "scope-1",
      expectedGeneration: 3,
      replacementTaskId: "task-1",
      replacementRunId: "run-2",
    });
    expect(dependencies.eventRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "clarification_resumed",
        payload: expect.objectContaining({ interruptId }),
      }),
    );
  });
});
