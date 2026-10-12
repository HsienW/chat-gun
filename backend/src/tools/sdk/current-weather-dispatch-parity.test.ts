import { createExecutionContextFixture } from "@gun-ai/harness-testkit";
import { describe, expect, it, vi } from "vitest";

import type { CompensationRegistry } from "../../runtime/compensation/compensation-registry.js";
import type { SagaOrchestrator } from "../../runtime/compensation/saga-orchestrator.js";
import type { ExecutionContext } from "../../runtime/execution-context/execution-context.js";
import { NoopStepLock } from "../../runtime/lock/step-lock.js";
import type { GovernedToolExecutor } from "../../runtime/side-effect/governed-outcome.js";
import type { ToolExecutionRunResult, ToolExecutionRunner } from "../../runtime/side-effect/tool-execution-runner.js";
import { ExecutionProfileEnforcer, ExecutionProfileRegistry } from "../../runtime/tool-dispatch/execution-profile.js";
import { createRuntimeToolDispatchPipeline } from "../../runtime/tool-dispatch/pipeline.js";
import {
  createLocalExecutionProfileRegistry,
  createLocalRuntimeToolDescriptorRegistry,
  createLocalRuntimeToolDescriptors,
  LOCAL_PRODUCTION_TOOLS,
} from "../production-runtime-tool-descriptors.js";
import { createLocalToolRiskPolicies } from "../authorization/tool-authorization.js";
import { stageCurrentWeatherSdkDescriptor } from "./current-weather-manifest-adapter.js";

type Scenario = "success" | "authorization_denial" | "sandbox_without_runner" | "timeout" | "cancellation";

function withoutAdditiveProvenance(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (key, entry) =>
    key === "manifestVersion" || key === "emittedAt" ? undefined : entry
  ));
}

async function runScenario(registration: "legacy" | "sdk", scenario: Scenario) {
  const legacyDescriptor = createLocalRuntimeToolDescriptors().find((entry) => entry.toolName === "current_weather");
  const tool = LOCAL_PRODUCTION_TOOLS.find((entry) => entry.name === "current_weather");
  const riskPolicy = createLocalToolRiskPolicies().find((entry) => entry.toolName === "current_weather");
  if (!legacyDescriptor || !tool || !riskPolicy || !legacyDescriptor.executionProfileRef) {
    throw new Error("Current weather host fixture is incomplete");
  }
  const profileRegistry = new ExecutionProfileRegistry();
  const profile = createLocalExecutionProfileRegistry().resolve(legacyDescriptor.executionProfileRef);
  if (!profile) throw new Error("Current weather execution profile is unavailable");
  profileRegistry.register(legacyDescriptor.executionProfileRef, {
    ...profile,
    mode: scenario === "sandbox_without_runner" ? "isolated_process" : profile.mode,
  });
  const descriptor = registration === "sdk"
    ? await stageCurrentWeatherSdkDescriptor({ tool, descriptor: legacyDescriptor, riskPolicy, profileRegistry })
    : legacyDescriptor;
  const registry = createLocalRuntimeToolDescriptorRegistry(
    createLocalRuntimeToolDescriptors().map((entry) => entry.toolName === "current_weather" ? descriptor : entry)
  );
  const runnerResult: ToolExecutionRunResult<string> = scenario === "timeout"
    ? { type: "failed", errorCode: "TOOL_TIMEOUT" }
    : scenario === "cancellation"
      ? { type: "cancelled", dispatchState: "after" }
      : { type: "succeeded", source: "live", result: "weather-ok" };
  const runnerExecute = vi.fn(async () => runnerResult);
  const audit = vi.fn(async (
    _eventName: string,
    _payload: Record<string, unknown>,
    _context: ExecutionContext
  ) => undefined);
  const compensationRegistry: CompensationRegistry = {
    register: vi.fn(), deregister: vi.fn(), getActions: vi.fn(() => []), hasActions: vi.fn(() => false),
  };
  const sagaOrchestrator: SagaOrchestrator = {
    compensate: vi.fn(async (taskId: string) => ({
      taskId, totalActions: 0, succeeded: 0, failed: 0, skippedIrreversible: 0,
      overallStatus: "no_actions_needed" as const, failures: [], skippedIrreversibleActions: [],
    })),
  };
  const pipeline = createRuntimeToolDispatchPipeline({
    registry,
    executionProfileEnforcer: new ExecutionProfileEnforcer({
      descriptorRegistry: registry, profileRegistry, isEnabled: () => true,
    }),
    toolExecutionRunner: { execute: runnerExecute as ToolExecutionRunner["execute"] },
    retryBudgetFactory: (stepId, policy) => ({
      stepId, maxAttempts: policy.maxAttempts, maxElapsedMs: policy.maxElapsedMs,
      startedAt: 0, attempts: 0,
    }),
    taskStepAdapter: {
      start: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    },
    compensationRegistry,
    sagaOrchestrator,
    observability: { audit, metric: vi.fn(async () => undefined) },
    stepLock: new NoopStepLock(),
    stepLockTtlMs: 30_000,
  });
  const sourceExecutor: GovernedToolExecutor<unknown, string> = {
    authorizeTyped: vi.fn(async () => scenario === "authorization_denial"
      ? { type: "denied_by_authorization" as const, errorCode: "TOOL_POLICY_DENIED", decisionId: "decision-1" }
      : { type: "authorized" as const, decisionId: "decision-1" }),
    executeAuthorizedTyped: vi.fn(async () => ({ type: "succeeded" as const, result: "weather-ok" })),
    executeTyped: vi.fn(async () => ({ type: "succeeded" as const, result: "weather-ok" })),
  };
  const context = createExecutionContextFixture({ stepId: "step-1", toolCallId: "tool-call-1" });
  const outcome = await pipeline.createExecutor("current_weather", sourceExecutor)
    .executeTyped({ location: "Taipei" }, { configurable: { execution_context: context } });
  const completionAudit = audit.mock.calls.find(([eventName]) => eventName === "tool.dispatch.completed");
  return {
    outcome,
    audit: completionAudit?.[1],
    runnerCallCount: runnerExecute.mock.calls.length,
    registeredNames: registry.list().map(({ toolName }) => toolName),
    descriptor,
    riskPolicy,
    profile: profileRegistry.resolve(legacyDescriptor.executionProfileRef),
  };
}

describe("current_weather legacy and SDK execution parity", () => {
  it.each([
    "success", "authorization_denial", "sandbox_without_runner", "timeout", "cancellation",
  ] as const)("keeps %s on the same authoritative path", async (scenario) => {
    const legacy = await runScenario("legacy", scenario);
    const sdk = await runScenario("sdk", scenario);
    expect(sdk.registeredNames).toEqual(legacy.registeredNames);
    expect(sdk.registeredNames.filter((name) => name === "current_weather")).toHaveLength(1);
    expect({
      toolName: sdk.riskPolicy.toolName,
      riskTier: sdk.riskPolicy.riskTier,
      actions: sdk.riskPolicy.actions,
      requireConfirmation: sdk.riskPolicy.requireConfirmation,
    }).toEqual({
      toolName: legacy.riskPolicy.toolName,
      riskTier: legacy.riskPolicy.riskTier,
      actions: legacy.riskPolicy.actions,
      requireConfirmation: legacy.riskPolicy.requireConfirmation,
    });
    expect(sdk.profile).toEqual(legacy.profile);
    expect(sdk.descriptor.executionProfileRef).toEqual(legacy.descriptor.executionProfileRef);
    expect(sdk.descriptor.egressRequirements).toEqual(legacy.descriptor.egressRequirements);
    expect(sdk.descriptor.timeoutPolicy).toEqual(legacy.descriptor.timeoutPolicy);
    expect(sdk.descriptor.retryPolicy).toEqual(legacy.descriptor.retryPolicy);
    expect(sdk.runnerCallCount).toBe(legacy.runnerCallCount);
    expect(withoutAdditiveProvenance(sdk.outcome)).toEqual(withoutAdditiveProvenance(legacy.outcome));
    expect(withoutAdditiveProvenance(sdk.audit)).toEqual(withoutAdditiveProvenance(legacy.audit));
    if (scenario === "success") {
      expect(sdk.outcome).toMatchObject({
        type: "succeeded",
        result: {
          manifestVersion: "1.0.0",
          correlation: { runId: "run-1", stepId: "step-1", toolCallId: "tool-call-1" },
          outcome: { type: "succeeded", result: "weather-ok" },
        },
      });
      expect(sdk.audit).toMatchObject({ manifestVersion: "1.0.0" });
    }
    if (scenario === "authorization_denial") {
      expect(sdk.outcome).toMatchObject({ type: "denied_by_authorization", errorCode: "TOOL_POLICY_DENIED" });
      expect(sdk.runnerCallCount).toBe(0);
    }
    if (scenario === "sandbox_without_runner") {
      expect(sdk.outcome).toMatchObject({ type: "rejected_before_dispatch", errorCode: "SANDBOX_RUNNER_UNAVAILABLE" });
      expect(sdk.runnerCallCount).toBe(0);
    }
    if (scenario === "timeout") {
      expect(sdk.outcome).toMatchObject({
        type: "succeeded",
        result: { outcome: { type: "failed_not_committed", errorCode: "TOOL_TIMEOUT" } },
      });
    }
    if (scenario === "cancellation") {
      expect(sdk.outcome).toMatchObject({
        type: "succeeded",
        result: { outcome: { type: "cancelled", dispatchState: "after" } },
      });
    }
  });
});
