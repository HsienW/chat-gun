import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { createNoopSpanManager } from "../../platform/tracing/span-manager.js";
import {
  deriveCancellationPhase,
  PgCancellationLedgerReader,
} from "../interaction/cancel-decision.js";
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
    transitionBusinessEffectAndExecution: (input) =>
      delegate.transitionBusinessEffectAndExecution(input),
    releaseClaim: (input) => delegate.releaseClaim(input),
    findBusinessEffectSnapshot: (businessEffectId) =>
      delegate.findBusinessEffectSnapshot(businessEffectId),
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
      terminationCause: "completed",
      businessEffectId: prepared.businessEffect.businessEffectId,
      expectedEffectState: "prepared",
    });

    const stored = await ledger.findExecutionByReplayKey(
      prepared.execution.replayKey
    );
    expect(stored?.terminationCause).toBe("completed");

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

  describe("claim release, reclaim and lock order (X43 T2a)", () => {
    function newRunner() {
      return new ToolExecutionRunner(ledger, resultStore, {
        spanManager: createNoopSpanManager(),
      });
    }

    function sharedInput(
      suffix: string,
      resourceId: string,
      toolExecutor: GovernedToolExecutor<TestInput, TestResult>,
      toolDescriptor = descriptor()
    ) {
      return { ...runnerInput(suffix, toolExecutor, toolDescriptor), input: { resourceId } };
    }

    async function effectRow(resourceId: string) {
      const result = await pool.query(
        `SELECT business_effect_id, commit_state, released_at
         FROM business_effects
         WHERE tenant_id = $1 AND business_effect_key = $2`,
        [tenantId, hashBusinessEffectKey(resourceId)]
      );
      return result.rows[0] as
        | { business_effect_id: string; commit_state: string; released_at: Date | null }
        | undefined;
    }

    async function executionRow(suffix: string) {
      const result = await pool.query(
        `SELECT status, claim_disposition, decision_id, termination_cause
         FROM tool_executions WHERE run_id = $1`,
        [`${runPrefix}-${suffix}`]
      );
      return result.rows[0] as
        | {
            status: string;
            claim_disposition: string | null;
            decision_id: string | null;
            termination_cause: string | null;
          }
        | undefined;
    }

    async function claimAndExecute(suffix: string, businessKey: string) {
      const prepared = await ledger.prepare(prepareInput(suffix, businessKey));
      if (prepared.type !== "claimed") throw new Error(`Expected a claim for ${suffix}`);
      await ledger.transitionExecution({
        toolExecutionId: prepared.execution.toolExecutionId,
        expectedStatus: "prepared",
        nextStatus: "executing",
      });
      return prepared;
    }

    it("releases a not-committed claim so a re-authorized submission runs once", async () => {
      const resourceId = `release-${suiteId}`;
      const dispatches = { first: 0, second: 0 };
      const runner = newRunner();

      await expect(
        runner.execute(sharedInput("release-first", resourceId, {
          executeTyped: async () => {
            dispatches.first += 1;
            return { type: "failed_not_committed", errorCode: "ORDER_NOT_FOUND" };
          },
        }))
      ).resolves.toMatchObject({ type: "failed", errorCode: "ORDER_NOT_FOUND" });
      const released = await effectRow(resourceId);
      expect(released?.commit_state).toBe("prepared");
      expect(released?.released_at).not.toBeNull();
      expect(await executionRow("release-first")).toMatchObject({
        status: "failed",
        claim_disposition: null,
        termination_cause: "failed_not_committed",
      });

      await expect(
        runner.execute(sharedInput("release-second", resourceId, {
          authorizeTyped: async () => ({ type: "authorized", decisionId: "decision-second" }),
          executeAuthorizedTyped: async () => {
            dispatches.second += 1;
            return { type: "succeeded", result: { operationId: `op-${suiteId}-second` } };
          },
          executeTyped: async () => {
            throw new Error("pre-authorized calls must use executeAuthorizedTyped");
          },
        }))
      ).resolves.toMatchObject({ type: "succeeded", source: "live" });
      expect(dispatches).toEqual({ first: 1, second: 1 });
      const committed = await effectRow(resourceId);
      expect(committed).toMatchObject({ commit_state: "committed", released_at: null });
      expect(committed?.business_effect_id).toBe(released?.business_effect_id);
      expect(await executionRow("release-second")).toMatchObject({
        status: "committed",
        decision_id: "decision-second",
      });
    });

    it("releases after reconciliation confirms not committed and never retries automatically", async () => {
      const resourceId = `reconcile-release-${suiteId}`;
      const dispatches = { count: 0 };

      await expect(
        newRunner().execute(sharedInput(
          "reconcile-release",
          resourceId,
          {
            executeTyped: async () => {
              dispatches.count += 1;
              return { type: "ambiguous_after_dispatch", errorCode: "RESPONSE_LOST" };
            },
          },
          descriptor({ reconcile: async () => ({ state: "not_committed" }) })
        ))
      ).resolves.toMatchObject({ type: "failed", errorCode: "SIDE_EFFECT_NOT_COMMITTED" });
      expect(dispatches.count).toBe(1);
      const released = await effectRow(resourceId);
      expect(released?.commit_state).toBe("prepared");
      expect(released?.released_at).not.toBeNull();
      expect(await executionRow("reconcile-release")).toMatchObject({ status: "failed" });
    });

    it("lets exactly one of two concurrent submissions reclaim a released effect", async () => {
      for (let round = 0; round < 10; round += 1) {
        const businessKey = `reclaim-race-${round}`;
        const holder = await claimAndExecute(`reclaim-holder-${round}`, businessKey);
        await ledger.releaseClaim({
          businessEffectId: holder.businessEffect.businessEffectId,
          expectedEffectState: "prepared",
          toolExecutionId: holder.execution.toolExecutionId,
          expectedExecutionStatus: "executing",
        });

        const results = await Promise.all([
          ledger.prepare(prepareInput(`reclaim-a-${round}`, businessKey)),
          ledger.prepare(prepareInput(`reclaim-b-${round}`, businessKey)),
        ]);

        expect(results.filter(({ type }) => type === "claimed")).toHaveLength(1);
        const loser = results.find(({ type }) => type === "not_claimed");
        expect(loser).toBeDefined();
        if (loser?.type !== "not_claimed") throw new Error("Expected a not_claimed loser");
        expect(loser.execution).toMatchObject({
          status: "failed",
          claimDisposition: "not_claimed",
        });
      }
    });

    it("never deadlocks when commit, release and reclaim race on one effect", async () => {
      const policy = descriptor().resultReferencePolicy;
      for (let round = 0; round < 20; round += 1) {
        const businessKey = `lock-order-${round}`;
        const holder = await claimAndExecute(`lock-holder-${round}`, businessKey);
        const reference = await resultStore.save({
          toolExecutionId: holder.execution.toolExecutionId,
          result: { operationId: `op-${suiteId}-lock-${round}` },
          policy,
          scope: { scopeId: "scope-1", tenantId, principalId: "principal-1" },
          toolVersion: "1",
        });

        const [commit, release, reclaim] = await Promise.allSettled([
          ledger.commitExecutionAndBusinessEffect({
            toolExecutionId: holder.execution.toolExecutionId,
            expectedExecutionStatus: "executing",
            resultRef: reference.resultRefId,
            businessEffectId: holder.businessEffect.businessEffectId,
            expectedEffectState: "prepared",
          }),
          ledger.releaseClaim({
            businessEffectId: holder.businessEffect.businessEffectId,
            expectedEffectState: "prepared",
            toolExecutionId: holder.execution.toolExecutionId,
            expectedExecutionStatus: "executing",
          }),
          ledger.prepare(prepareInput(`lock-reclaim-${round}`, businessKey)),
        ]);

        // A deadlock aborts a transaction: it would surface as a non-CAS
        // rejection or as an unavailable prepare.
        for (const settled of [commit, release]) {
          if (settled.status === "rejected") {
            expect(settled.reason).toMatchObject({ name: "SideEffectStateConflictError" });
          }
        }
        expect(reclaim.status).toBe("fulfilled");
        if (reclaim.status !== "fulfilled") continue;
        expect(reclaim.value.type).not.toBe("unavailable");
        expect(
          [commit, release].filter((settled) => settled.status === "fulfilled")
        ).toHaveLength(1);

        const finalEffect = await pool.query(
          `SELECT commit_state, released_at FROM business_effects
           WHERE business_effect_id = $1`,
          [holder.businessEffect.businessEffectId]
        );
        const state = finalEffect.rows[0] as { commit_state: string; released_at: Date | null };
        if (commit.status === "fulfilled") {
          expect(state).toEqual({ commit_state: "committed", released_at: null });
          expect(["existing_committed", "not_claimed"]).toContain(reclaim.value.type);
        } else if (reclaim.value.type === "claimed") {
          expect(state).toEqual({ commit_state: "prepared", released_at: null });
        } else {
          expect(reclaim.value.type).toBe("not_claimed");
          expect(state.commit_state).toBe("prepared");
        }
      }
    });

    it("answers a replayed not-claimed submission from the original effect without reconciliation", async () => {
      const resourceId = `replay-${suiteId}`;
      const holder = await claimAndExecute("replay-holder", resourceId);
      const dispatches = { count: 0 };
      const duplicate = sharedInput("replay-duplicate", resourceId, {
        executeTyped: async () => {
          dispatches.count += 1;
          return { type: "succeeded", result: { operationId: "never" } };
        },
      });
      const runner = newRunner();

      await expect(runner.execute(duplicate)).resolves.toMatchObject({
        type: "deferred",
        errorCode: "SIDE_EFFECT_CLAIM_NOT_ACQUIRED",
      });
      expect(await executionRow("replay-duplicate")).toMatchObject({
        status: "failed",
        claim_disposition: "not_claimed",
      });
      await expect(runner.execute(duplicate)).resolves.toMatchObject({
        type: "deferred",
        errorCode: "SIDE_EFFECT_CLAIM_NOT_ACQUIRED",
      });
      expect(await executionRow("replay-duplicate")).toMatchObject({ status: "failed" });

      const reference = await resultStore.save({
        toolExecutionId: holder.execution.toolExecutionId,
        result: { operationId: `op-${suiteId}-replay` },
        policy: descriptor().resultReferencePolicy,
        scope: { scopeId: "scope-1", tenantId, principalId: "principal-1" },
        toolVersion: "1",
      });
      await ledger.commitExecutionAndBusinessEffect({
        toolExecutionId: holder.execution.toolExecutionId,
        expectedExecutionStatus: "executing",
        resultRef: reference.resultRefId,
        businessEffectId: holder.businessEffect.businessEffectId,
        expectedEffectState: "prepared",
      });

      await expect(runner.execute(duplicate)).resolves.toMatchObject({
        type: "succeeded",
        source: "cache",
        result: { operationId: `op-${suiteId}-replay` },
      });
      expect(dispatches.count).toBe(0);
    });

    it("reports in-flight duplicates and reused results with their origin (X43 T2b)", async () => {
      const resourceId = `dedup-${suiteId}`;
      const dispatches = { count: 0 };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let markDispatched!: () => void;
      const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
      const holdingExecutor: GovernedToolExecutor<TestInput, TestResult> = {
        executeTyped: async () => {
          dispatches.count += 1;
          markDispatched();
          await gate;
          return { type: "succeeded", result: { operationId: `op-${suiteId}-dedup` } };
        },
      };
      const neverExecutor: GovernedToolExecutor<TestInput, TestResult> = {
        executeTyped: async () => {
          dispatches.count += 1;
          return { type: "succeeded", result: { operationId: "never" } };
        },
      };
      const runner = newRunner();

      const first = runner.execute(sharedInput("dedup-first", resourceId, holdingExecutor));
      await dispatched;
      const duplicate = sharedInput("dedup-second", resourceId, neverExecutor);
      const held = await runner.execute(duplicate);
      const effect = await effectRow(resourceId);
      expect(held).toMatchObject({
        type: "deferred",
        errorCode: "SIDE_EFFECT_CLAIM_NOT_ACQUIRED",
        duplicateOf: {
          reason: "in_flight_duplicate",
          original: { businessEffectId: effect?.business_effect_id },
        },
      });
      expect(await executionRow("dedup-second")).toMatchObject({
        status: "failed",
        claim_disposition: "not_claimed",
        termination_cause: "deduplicated",
      });

      release();
      const committed = await first;
      expect(committed).toMatchObject({ type: "succeeded", source: "live" });
      const originalExecutionId =
        committed.type === "succeeded" ? committed.toolExecutionId : undefined;

      await expect(
        runner.execute(sharedInput("dedup-third", resourceId, neverExecutor))
      ).resolves.toMatchObject({
        type: "succeeded",
        source: "cache",
        result: { operationId: `op-${suiteId}-dedup` },
        reusedFrom: {
          businessEffectId: effect?.business_effect_id,
          toolExecutionId: originalExecutionId,
        },
      });
      expect(await executionRow("dedup-third")).toMatchObject({
        status: "committed",
        termination_cause: "deduplicated",
      });
      await expect(runner.execute(duplicate)).resolves.toMatchObject({
        type: "succeeded",
        source: "cache",
        reusedFrom: { toolExecutionId: originalExecutionId },
      });
      expect(dispatches.count).toBe(1);
    });

    it("reports a duplicate of an unknown outcome without reconciliation (X43 T2b)", async () => {
      const resourceId = `dedup-unknown-${suiteId}`;
      const runner = newRunner();
      await expect(
        runner.execute(sharedInput("dedup-unknown-first", resourceId, {
          executeTyped: async () => ({
            type: "ambiguous_after_dispatch",
            errorCode: "RESPONSE_LOST",
          }),
        }))
      ).resolves.toMatchObject({ errorCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED" });
      const reconcile = vi.fn(async () => ({ state: "committed" as const }));

      await expect(
        runner.execute(sharedInput(
          "dedup-unknown-second",
          resourceId,
          { executeTyped: async () => ({ type: "succeeded", result: { operationId: "never" } }) },
          descriptor({ reconcile })
        ))
      ).resolves.toMatchObject({
        type: "deferred",
        errorCode: "SIDE_EFFECT_CLAIM_NOT_ACQUIRED",
        duplicateOf: { reason: "original_outcome_unknown" },
      });
      expect(reconcile).not.toHaveBeenCalled();
      expect(await executionRow("dedup-unknown-second")).toMatchObject({
        status: "failed",
        claim_disposition: "not_claimed",
      });
    });

    it("keeps released effects and not-claimed executions readable by the existing cancellation reader", async () => {
      const businessKey = `old-reader-${suiteId}`;
      const holder = await claimAndExecute("old-reader-holder", businessKey);
      const inFlight = await ledger.prepare(prepareInput("old-reader-duplicate", businessKey));
      expect(inFlight.type).toBe("not_claimed");
      await ledger.releaseClaim({
        businessEffectId: holder.businessEffect.businessEffectId,
        expectedEffectState: "prepared",
        toolExecutionId: holder.execution.toolExecutionId,
        expectedExecutionStatus: "executing",
      });
      const reader = new PgCancellationLedgerReader(database, () => false);

      for (const suffix of ["old-reader-holder", "old-reader-duplicate"]) {
        const entries = await reader.getRunEntries(`${runPrefix}-${suffix}`);
        expect(entries).toEqual([
          expect.objectContaining({ executionStatus: "failed", effectCommitState: "prepared" }),
        ]);
        expect(deriveCancellationPhase(entries)).toBe("read_only");
      }
    });
  });
});
