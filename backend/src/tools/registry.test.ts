import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompensationRegistry } from "../runtime/compensation/compensation-registry.js";
import type { SagaOrchestrator } from "../runtime/compensation/saga-orchestrator.js";
import type { ToolExecutionRunner } from "../runtime/side-effect/tool-execution-runner.js";
import { getGovernedToolExecutor } from "../platform/tool-governance.js";
import {
  isToolDispatchPipelineEnabled,
  loadAgentToolRuntime,
} from "./registry.js";

describe("tool dispatch pipeline feature flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["math_agent", "TOOL_DISPATCH_PIPELINE_MATH_ENABLED"],
    ["deep_researcher", "TOOL_DISPATCH_PIPELINE_DEEP_RESEARCHER_ENABLED"],
    ["mcp_agent", "TOOL_DISPATCH_PIPELINE_MCP_ENABLED"],
  ] as const)("keeps %s disabled by default and enables only its own flag", (source, flag) => {
    expect(isToolDispatchPipelineEnabled(source)).toBe(false);

    vi.stubEnv(flag, "true");

    expect(isToolDispatchPipelineEnabled(source)).toBe(true);
  });

  it("fails closed for an unknown agent source", () => {
    vi.stubEnv("TOOL_DISPATCH_PIPELINE_MCP_ENABLED", "true");

    expect(isToolDispatchPipelineEnabled("unknown_agent")).toBe(false);
  });

  it.each([
    ["math_agent", "TOOL_DISPATCH_PIPELINE_MATH_ENABLED"],
    ["deep_researcher", "TOOL_DISPATCH_PIPELINE_DEEP_RESEARCHER_ENABLED"],
    ["mcp_agent", "TOOL_DISPATCH_PIPELINE_MCP_ENABLED"],
  ] as const)("routes enabled %s tools through the shared dispatcher runner", async (source, flag) => {
    vi.stubEnv(flag, "true");
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    const runnerExecute = vi.fn(async () => ({
      type: "succeeded" as const,
      source: "live" as const,
      result: "4",
    }));
    const compensationRegistry: CompensationRegistry = {
      register: vi.fn(),
      deregister: vi.fn(),
      getActions: vi.fn(() => []),
      hasActions: vi.fn(() => false),
    };
    const sagaOrchestrator: SagaOrchestrator = {
      compensate: vi.fn(async (taskId: string) => ({
        taskId,
        totalActions: 0,
        succeeded: 0,
        failed: 0,
        skippedIrreversible: 0,
        overallStatus: "no_actions_needed" as const,
        failures: [],
        skippedIrreversibleActions: [],
      })),
    };
    const runtime = await loadAgentToolRuntime(source, {
      dispatchPipelineDependencies: {
        toolExecutionRunner: {
          execute: runnerExecute as ToolExecutionRunner["execute"],
        },
        retryBudgetFactory: (stepId, policy) => ({
          stepId,
          maxAttempts: policy.maxAttempts,
          maxElapsedMs: policy.maxElapsedMs,
          startedAt: Date.now(),
          attempts: 0,
        }),
        taskStepAdapter: {
          start: vi.fn(async () => undefined),
          complete: vi.fn(async () => undefined),
          fail: vi.fn(async () => undefined),
        },
        compensationRegistry,
        sagaOrchestrator,
        observability: {
          audit: vi.fn(async () => undefined),
          metric: vi.fn(async () => undefined),
        },
      },
    });
    const calculator = runtime.tools.find(
      (tool) => tool.name === "calculator_tool"
    );
    expect(calculator).toBeDefined();
    const executor = calculator
      ? getGovernedToolExecutor(calculator)
      : undefined;

    const outcome = await executor?.executeTyped(
      { expression: "2 + 2" },
      {
        configurable: {
          execution_context: {
            requestId: "request-1",
            threadId: "thread-1",
            runId: "run-1",
            taskId: "task-1",
            stepId: "step-1",
            toolCallId: "tool-call-1",
            attempt: 1,
            principal: {
              principalId: "principal-1",
              principalType: "user",
              tenantId: "tenant-1",
              roles: [],
              scopes: [],
              authSource: "development",
              authenticatedAt: "2026-09-23T00:00:00.000Z",
            },
            scope: {
              scopeId: "scope-1",
              scopeType: "principal",
              tenantId: "tenant-1",
              ownerPrincipalId: "principal-1",
            },
          },
        },
      }
    );

    expect(runnerExecute).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      type: "succeeded",
      result: {
        kind: "tool_result",
        outcome: { type: "succeeded", result: "4" },
      },
    });
  });
});
