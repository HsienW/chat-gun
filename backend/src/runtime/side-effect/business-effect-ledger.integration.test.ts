import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { createNoopSpanManager } from "../../platform/tracing/span-manager.js";
import { runMigrations } from "../persistence/migration-runner.js";
import {
  PgBusinessEffectLedger,
  PgSideEffectDatabase,
  type BusinessEffectLedger,
  type PrepareSideEffectInput,
  type SideEffectDatabase,
} from "./business-effect-ledger.js";
import type { GovernedToolExecutor } from "./governed-outcome.js";
import { createReplayKey, hashBusinessEffectKey } from "./identity.js";
import { PgResultReferenceStore } from "./result-reference-store.js";
import type { SideEffectToolDescriptor } from "./side-effect-descriptor.js";
import { ToolExecutionRunner } from "./tool-execution-runner.js";

const databaseUrl = process.env.SIDE_EFFECT_INTEGRATION_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const suiteId = randomUUID();
const tenantId = `side-effect-integration-${suiteId}`;
const runPrefix = `side-effect-integration-${suiteId}`;

type TestInput = { resourceId: string };
type TestResult = { operationId: string };

function prepareInput(suffix: string, businessKey = `resource-${suffix}`): PrepareSideEffectInput {
  return {
    businessEffectId: randomUUID(),
    toolExecutionId: randomUUID(),
    businessEffectKey: hashBusinessEffectKey(businessKey),
    scope: {
      scopeId: "scope-1",
      tenantId,
      principalId: "principal-1",
    },
    replayKey: createReplayKey({
      runId: `${runPrefix}-${suffix}`,
      stepId: `step-${suffix}`,
      logicalToolCallId: `call-${suffix}`,
      callIndex: 0,
      toolName: "integration_side_effect",
      toolVersion: "1",
    }),
    requestHash: `request-hash-${suffix}`,
    runId: `${runPrefix}-${suffix}`,
    stepId: `step-${suffix}`,
    callIndex: 0,
    toolName: "integration_side_effect",
    toolVersion: "1",
  };
}

function descriptor(
  reconcile?: SideEffectToolDescriptor<TestInput, TestResult>["reconcile"]
): SideEffectToolDescriptor<TestInput, TestResult> {
  return {
    toolName: "integration_side_effect",
    toolVersion: "1",
    deriveBusinessEffectKey: ({ resourceId }) => resourceId,
    ...(reconcile ? { reconcile } : {}),
    resultReferencePolicy: {
      toResultRef: ({ operationId }) => ({
        resultHash: `hash-${operationId}`,
        payloadRef: `payload://${operationId}`,
        externalSystemNamespace: "integration-system",
        externalOperationId: operationId,
      }),
      resolveResultRef: async (payloadRef) => ({
        operationId: payloadRef.slice("payload://".length),
      }),
      isReusable: (state) => state === "reusable",
    },
  };
}

function executor(
  outcome:
    | { type: "succeeded"; result: TestResult }
    | { type: "ambiguous_after_dispatch"; errorCode: string },
  dispatches: { count: number }
): GovernedToolExecutor<TestInput, TestResult> {
  return {
    executeTyped: async () => {
      dispatches.count += 1;
      return outcome;
    },
  };
}

function runnerInput(
  suffix: string,
  toolExecutor: GovernedToolExecutor<TestInput, TestResult>,
  toolDescriptor: SideEffectToolDescriptor<TestInput, TestResult>
) {
  return {
    identity: {
      runId: `${runPrefix}-${suffix}`,
      stepId: `step-${suffix}`,
      logicalToolCallId: `call-${suffix}`,
      callIndex: 0,
      toolName: "integration_side_effect",
      toolVersion: "1",
    },
    requestHash: `request-hash-${suffix}`,
    scope: {
      scopeId: "scope-1",
      tenantId,
      principalId: "principal-1",
    },
    input: { resourceId: `resource-${suffix}` },
    retryAfterMaxMs: 30_000,
    executor: toolExecutor,
    descriptor: toolDescriptor,
    requestId: `request-${suffix}`,
    threadId: `thread-${suffix}`,
  };
}

function withAtomicCommitFailure(delegate: BusinessEffectLedger): BusinessEffectLedger {
  return {
    prepare: (input) => delegate.prepare(input),
    findExecutionByReplayKey: (replayKey) =>
      delegate.findExecutionByReplayKey(replayKey),
    recordAttempt: (input) => delegate.recordAttempt(input),
    completeAttempt: (input) => delegate.completeAttempt(input),
    linkAuthorizationDecision: (input) =>
      delegate.linkAuthorizationDecision(input),
    transitionExecution: (input) => delegate.transitionExecution(input),
    transitionBusinessEffect: (input) => delegate.transitionBusinessEffect(input),
    commitExecutionAndBusinessEffect: async () => {
      throw new Error("injected commit response loss");
    },
    findCommittedExecutionByStepId: (stepId) =>
      delegate.findCommittedExecutionByStepId(stepId),
    prepareCompensationExecution: (input) =>
      delegate.prepareCompensationExecution(input),
    transitionCompensationExecution: (input) =>
      delegate.transitionCompensationExecution(input),
  };
}

describePostgres("side-effect PostgreSQL integration", () => {
  let pool: Pool;
  let database: PgSideEffectDatabase;
  let ledger: PgBusinessEffectLedger;
  let resultStore: PgResultReferenceStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 10, ssl: false });
    database = new PgSideEffectDatabase(pool);
    ledger = new PgBusinessEffectLedger(database);
    resultStore = new PgResultReferenceStore(database);
    await runMigrations("up", database);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    const runPattern = `${runPrefix}%`;
    await pool.query(
      `DELETE FROM result_references
       WHERE tool_execution_id IN (
         SELECT tool_execution_id FROM tool_executions WHERE run_id LIKE $1
       )`,
      [runPattern]
    );
    await pool.query(
      `DELETE FROM tool_execution_attempts
       WHERE tool_execution_id IN (
         SELECT tool_execution_id FROM tool_executions WHERE run_id LIKE $1
       )`,
      [runPattern]
    );
    await pool.query("DELETE FROM tool_executions WHERE run_id LIKE $1", [runPattern]);
    await pool.query("DELETE FROM business_effects WHERE tenant_id = $1", [tenantId]);
    await pool.end();
  }, 30_000);

  it("allows only one of two concurrent workers to claim the same business effect", async () => {
    const sharedBusinessKey = "shared-concurrent-effect";
    const results = await Promise.all([
      ledger.prepare(prepareInput("concurrent-a", sharedBusinessKey)),
      ledger.prepare(prepareInput("concurrent-b", sharedBusinessKey)),
    ]);

    expect(results.filter(({ type }) => type === "claimed")).toHaveLength(1);
    expect(results.filter(({ type }) => type === "not_claimed")).toHaveLength(1);
  });

  it("returns conflict for the same replay key with a different request hash", async () => {
    const first = prepareInput("replay-conflict");
    await expect(ledger.prepare(first)).resolves.toMatchObject({ type: "claimed" });

    await expect(
      ledger.prepare({
        ...first,
        businessEffectId: randomUUID(),
        toolExecutionId: randomUUID(),
        requestHash: "different-request-hash",
      })
    ).resolves.toMatchObject({ type: "conflict" });
  });

  it("fails closed before dispatch when the ledger is unavailable", async () => {
    const unavailableDatabase: SideEffectDatabase = {
      query: async () => {
        throw new Error("database unavailable");
      },
      withTransaction: async () => {
        throw new Error("database unavailable");
      },
    };
    const unavailableLedger = new PgBusinessEffectLedger(unavailableDatabase);
    const dispatches = { count: 0 };
    const toolRunner = new ToolExecutionRunner(unavailableLedger, resultStore, {
      spanManager: createNoopSpanManager(),
    });

    await expect(
      toolRunner.execute(
        runnerInput(
          "unavailable",
          executor({ type: "succeeded", result: { operationId: "never" } }, dispatches),
          descriptor()
        )
      )
    ).resolves.toMatchObject({
      type: "deferred",
      errorCode: "SIDE_EFFECT_LEDGER_UNAVAILABLE",
    });
    expect(dispatches.count).toBe(0);
  });

  it("does not redispatch after downstream success when atomic ledger commit is lost", async () => {
    const dispatches = { count: 0 };
    const toolRunner = new ToolExecutionRunner(
      withAtomicCommitFailure(ledger),
      resultStore,
      { spanManager: createNoopSpanManager() }
    );

    await expect(
      toolRunner.execute(
        runnerInput(
          "commit-fault",
          executor(
            { type: "succeeded", result: { operationId: `op-${suiteId}-fault` } },
            dispatches
          ),
          descriptor()
        )
      )
    ).resolves.toMatchObject({
      type: "deferred",
      errorCode: "SIDE_EFFECT_PERSISTENCE_UNCERTAIN",
    });
    expect(dispatches.count).toBe(1);
  });

  it("rolls back the execution transition when the business effect CAS fails", async () => {
    const prepared = await ledger.prepare(prepareInput("atomic-rollback"));
    if (prepared.type !== "claimed") throw new Error("Expected claimed execution");
    await ledger.transitionExecution({
      toolExecutionId: prepared.execution.toolExecutionId,
      expectedStatus: "prepared",
      nextStatus: "executing",
    });

    await expect(
      ledger.commitExecutionAndBusinessEffect({
        toolExecutionId: prepared.execution.toolExecutionId,
        expectedExecutionStatus: "executing",
        resultRef: "result-ref-does-not-exist",
        businessEffectId: prepared.businessEffect.businessEffectId,
        expectedEffectState: "unknown",
      })
    ).rejects.toMatchObject({ name: "SideEffectStateConflictError" });

    const stored = await ledger.findExecutionByReplayKey(
      prepared.execution.replayKey
    );
    expect(stored?.status).toBe("executing");
    expect(stored?.resultRef).toBeUndefined();
  });

  it("moves ambiguous execution through unknown and commits reconciled state", async () => {
    const dispatches = { count: 0 };
    const operationId = `op-${suiteId}-reconciled`;
    const toolRunner = new ToolExecutionRunner(ledger, resultStore, {
      spanManager: createNoopSpanManager(),
    });

    await expect(
      toolRunner.execute(
        runnerInput(
          "reconciled",
          executor(
            { type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" },
            dispatches
          ),
          descriptor({
            reconcile: async () => ({
              state: "committed",
              result: { operationId },
            }),
          })
        )
      )
    ).resolves.toMatchObject({ type: "succeeded", source: "reconciled" });
    expect(dispatches.count).toBe(1);
  });

  it("persists manual intervention when ambiguity has no reconciler", async () => {
    const dispatches = { count: 0 };
    const suffix = "manual";
    const input = runnerInput(
      suffix,
      executor(
        { type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" },
        dispatches
      ),
      descriptor()
    );
    const toolRunner = new ToolExecutionRunner(ledger, resultStore, {
      spanManager: createNoopSpanManager(),
    });

    await expect(toolRunner.execute(input)).resolves.toMatchObject({
      type: "deferred",
      errorCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED",
    });
    const stored = await ledger.findExecutionByReplayKey(createReplayKey(input.identity));
    expect(stored?.status).toBe("manual_intervention_required");
    expect(dispatches.count).toBe(1);
  });

  it("keeps tombstones by default and stores only explicit expiry", async () => {
    const defaultInput = prepareInput("tombstone-default");
    const explicitInput = {
      ...prepareInput("tombstone-explicit"),
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const defaultResult = await ledger.prepare(defaultInput);
    const explicitResult = await ledger.prepare(explicitInput);

    expect(defaultResult.type).toBe("claimed");
    expect(explicitResult.type).toBe("claimed");
    if (defaultResult.type !== "claimed" || explicitResult.type !== "claimed") {
      throw new Error("Expected both tombstone preparations to be claimed");
    }
    expect(defaultResult.businessEffect).not.toHaveProperty("expiresAt");
    expect(explicitResult.businessEffect.expiresAt).toBe(
      "2030-01-01T00:00:00.000Z"
    );
  });

  it("rejects cached result reuse when authorization scope does not match", async () => {
    const prepared = await ledger.prepare(prepareInput("scope-mismatch"));
    if (prepared.type !== "claimed") throw new Error("Expected claimed execution");
    await ledger.transitionExecution({
      toolExecutionId: prepared.execution.toolExecutionId,
      expectedStatus: "prepared",
      nextStatus: "executing",
    });
    const policy = descriptor().resultReferencePolicy;
    const reference = await resultStore.save({
      toolExecutionId: prepared.execution.toolExecutionId,
      result: { operationId: `op-${suiteId}-scope` },
      policy,
      scope: {
        scopeId: "scope-1",
        tenantId,
        principalId: "principal-1",
      },
      toolVersion: "1",
    });
    await ledger.commitExecutionAndBusinessEffect({
      toolExecutionId: prepared.execution.toolExecutionId,
      expectedExecutionStatus: "executing",
      resultRef: reference.resultRefId,
      businessEffectId: prepared.businessEffect.businessEffectId,
      expectedEffectState: "prepared",
    });

    await expect(
      resultStore.resolve({
        resultRefId: reference.resultRefId,
        policy,
        scope: {
          scopeId: "scope-1",
          tenantId,
          principalId: "other-principal",
        },
        toolVersion: "1",
      })
    ).resolves.toBeNull();
  });
});
