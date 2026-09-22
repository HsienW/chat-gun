import type { RunnableConfig } from "@langchain/core/runnables";
import { readFileSync } from "node:fs";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  applyToolGovernance,
  defaultToolPolicy,
  GovernanceExecutor,
  GovernedDispatchError,
  type ToolAuthorizationGovernanceConfig,
} from "./tool-governance.js";
import { ToolRiskRegistry, type ToolRiskPolicy } from "../runtime/authorization/tool-risk.js";
import { executionContextSchema } from "../runtime/execution-context/execution-context.js";
import { createConfirmationRequiredDescriptor } from "../runtime/authorization/confirmation.js";
import {
  createNoopOpikTracer,
  setOpikTracerForTests,
  type ToolSpanMetadata,
} from "./tracing/opik/opik-tracer.js";

function createEchoTool(output: string): StructuredToolInterface {
  return tool(
    async ({ value }: { value: string }) => `${value}:${output}`,
    {
      name: "contract_echo",
      description: "Echoes a validated string input.",
      schema: z.object({
        value: z.string(),
      }),
    }
  ) as StructuredToolInterface;
}

const contextFixture = JSON.parse(readFileSync(
  new URL("../../../contracts/execution-context.fixture.json", import.meta.url),
  "utf8"
)) as { validContext: unknown };
const executionContext = executionContextSchema.parse(contextFixture.validContext);

function createAuthorizationConfig(
  effect: "allow" | "deny" | "require_confirmation",
  onRequireConfirmation?: ToolAuthorizationGovernanceConfig["onRequireConfirmation"],
  riskTier: ToolRiskPolicy["riskTier"] = "read",
  includeContextProvider = true
): {
  config: ToolAuthorizationGovernanceConfig;
  authorize: ReturnType<typeof vi.fn>;
  recordDecision: ReturnType<typeof vi.fn>;
} {
  const riskPolicy: ToolRiskPolicy = {
    toolName: "contract_echo",
    riskTier,
    actions: ["task:read"],
    requireConfirmation: false,
    resourceRefResolver: (_input, scope) => ({
      resourceType: "task",
      resourceId: "task-1",
      tenantId: scope.tenantId,
    }),
  };
  const authorize = vi.fn(async () => ({
    decisionId: `decision-${effect}`,
    effect,
    reasonCode:
      effect === "allow"
        ? ("POLICY_ALLOWED" as const)
        : effect === "deny"
          ? ("MISSING_ROLE_SCOPE_GRANT" as const)
          : ("REQUIRES_CONFIRMATION" as const),
    createdAt: "2026-08-18T00:00:00.000Z",
  }));
  const recordDecision = vi.fn(async () => undefined);
  return {
    authorize,
    recordDecision,
    config: {
      riskRegistry: new ToolRiskRegistry([riskPolicy], {
        unregisteredToolDefault: "read",
      }),
      authorizationEngine: { authorize },
      decisionStore: { record: recordDecision },
      policyVersion: "runtime-authorization-v1",
      ...(includeContextProvider
        ? {
            resolveContext: () => ({
              principal: executionContext.principal,
              scope: executionContext.scope,
            }),
          }
        : {}),
      ...(onRequireConfirmation === undefined ? {} : { onRequireConfirmation }),
    },
  };
}

describe("applyToolGovernance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    setOpikTracerForTests(undefined);
  });

  it("wraps governed execution in an Opik tool span with existing identifiers", async () => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    const withToolSpan = vi.fn();
    const tracer = createNoopOpikTracer();
    tracer.withToolSpan = async function withToolSpanForTest<T>(
      metadata: ToolSpanMetadata,
      operation: () => Promise<T>,
      input?: unknown
    ): Promise<T> {
      withToolSpan(metadata, operation, input);
      return operation();
    };
    setOpikTracerForTests(tracer);

    const [governedTool] = applyToolGovernance([createEchoTool("ok")]);
    await expect(
      governedTool.invoke(
        { value: "valid" },
        {
          configurable: {
            step_id: "step-1",
            tool_call_id: "tool-call-1",
          },
        }
      )
    ).resolves.toBe("valid:ok");
    expect(withToolSpan).toHaveBeenCalledWith(
      {
        toolName: "contract_echo",
        stepId: "step-1",
        toolCallId: "tool-call-1",
      },
      expect.any(Function),
      { value: "valid" }
    );
  });

  it("returns a safe governed error when tool input fails runtime schema validation", async () => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");

    const [governedTool] = applyToolGovernance([createEchoTool("ok")]);
    const result = await governedTool.invoke({ value: 123 });

    expect(result).toContain("Error: contract_echo failed by tool governance");
    expect(result).toContain("Received tool input did not match expected schema");
  });

  it("truncates oversized tool output at the governed boundary", async () => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    vi.stubEnv("TOOL_CONTRACT_ECHO_MAX_OUTPUT_CHARS", "1000");

    const [governedTool] = applyToolGovernance([createEchoTool("x".repeat(1200))]);
    const result = await governedTool.invoke({ value: "valid" });

    expect(result).toContain("[Tool output truncated by governance: contract_echo, 1000 characters]");
    expect(String(result).length).toBeLessThan(1200);
  });

  it("aborts the underlying operation and marks governance timeouts with a stable prefix", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    vi.stubEnv("TOOL_CONTRACT_WAIT_TIMEOUT_MS", "1000");
    let receivedAbort = false;
    const waitingTool = tool(
      async (_input: { value: string }, config?: RunnableConfig) => {
        expect(config?.configurable).not.toHaveProperty("abortSignal");
        const signal = config?.signal;

        return await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              receivedAbort = true;
              reject(signal.reason);
            },
            { once: true }
          );
        });
      },
      {
        name: "contract_wait",
        description: "Waits until the governed deadline aborts the operation.",
        schema: z.object({ value: z.string() }),
      }
    ) as StructuredToolInterface;

    const [governedTool] = applyToolGovernance([waitingTool]);
    const resultPromise = governedTool.invoke({ value: "valid" });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(receivedAbort).toBe(true);
    expect(result).toContain("[governance_timeout]");
  });
});

describe("GovernanceExecutor.executeTyped", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    setOpikTracerForTests(undefined);
  });

  it("returns succeeded with the governed result", async () => {
    const executor = new GovernanceExecutor(
      createEchoTool("ok"),
      { ...defaultToolPolicy("contract_echo"), audit: false }
    );

    await expect(executor.executeTyped({ value: "valid" })).resolves.toEqual({
      type: "succeeded",
      result: "valid:ok",
    });
  });

  it("authorizes with an explicitly injected development identity before dispatch", async () => {
    const invoked = vi.fn(async ({ value }: { value: string }) => `${value}:ok`);
    const sourceTool = tool(invoked, {
      name: "contract_echo",
      description: "Echoes a value after authorization.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const authorization = createAuthorizationConfig("allow", undefined, "read", false);
    const executor = new GovernanceExecutor(
      sourceTool,
      { ...defaultToolPolicy(sourceTool.name), audit: false },
      {
        ...authorization.config,
        resolveContext: () => ({
          principal: {
            principalId: "anonymous",
            principalType: "user",
            tenantId: "public",
            roles: [],
            scopes: [],
            authSource: "development",
            authenticatedAt: "2026-08-18T00:00:00.000Z",
          },
          scope: {
            scopeId: "development-public-anonymous",
            scopeType: "principal",
            tenantId: "public",
            ownerPrincipalId: "anonymous",
          },
        }),
      }
    );

    await expect(executor.executeTyped({ value: "valid" })).resolves.toEqual({
      type: "succeeded",
      result: "valid:ok",
    });
    expect(invoked).toHaveBeenCalledOnce();
    expect(authorization.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({
          principalId: "anonymous",
          tenantId: "public",
          authSource: "development",
        }),
        scope: expect.objectContaining({ tenantId: "public" }),
        resource: expect.objectContaining({ tenantId: "public" }),
      })
    );
  });

  it("does not treat NODE_ENV=development as authorization opt-in", async () => {
    const invoked = vi.fn(async () => "unexpected");
    const sourceTool = tool(invoked, {
      name: "contract_echo",
      description: "Requires an explicit authorization profile before dispatch.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const authorization = createAuthorizationConfig("allow", undefined, "read", false);
    const executor = new GovernanceExecutor(
      sourceTool,
      { ...defaultToolPolicy(sourceTool.name), audit: false },
      authorization.config
    );

    await expect(executor.executeTyped({ value: "valid" })).resolves.toMatchObject({
      type: "denied_by_authorization",
      errorCode: "AUTHORIZATION_UNAVAILABLE",
    });
    expect(authorization.authorize).not.toHaveBeenCalled();
    expect(invoked).not.toHaveBeenCalled();
  });

  it.each(["production", "test"])("denies missing identity in %s before authorization or tool dispatch", async (profile) => {
    vi.stubEnv("NODE_ENV", profile);
    const invoked = vi.fn(async () => "unexpected");
    const sourceTool = tool(invoked, {
      name: "contract_echo",
      description: "Requires an identity before dispatch.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const authorization = createAuthorizationConfig("allow", undefined, "read", false);
    const executor = new GovernanceExecutor(
      sourceTool,
      { ...defaultToolPolicy(sourceTool.name), audit: false },
      authorization.config
    );
    await expect(executor.executeTyped({ value: "valid" })).resolves.toMatchObject({
      type: "denied_by_authorization",
      errorCode: "AUTHORIZATION_UNAVAILABLE",
    });
    expect(authorization.authorize).not.toHaveBeenCalled();
    expect(invoked).not.toHaveBeenCalled();
  });

  it("uses an explicitly trusted ExecutionContext for authorization and decision correlation", async () => {
    const authorization = createAuthorizationConfig("allow");
    const executor = new GovernanceExecutor(
      createEchoTool("ok"),
      { ...defaultToolPolicy("contract_echo"), audit: false },
      { ...authorization.config, resolveExecutionContext: () => executionContext }
    );

    await expect(executor.executeTyped({ value: "valid" }, {
      configurable: { requestId: "forged-request" },
    })).resolves.toMatchObject({ type: "succeeded" });
    expect(authorization.authorize).toHaveBeenCalledWith(expect.objectContaining({
      principal: executionContext.principal,
      scope: executionContext.scope,
      context: expect.objectContaining({ requestId: executionContext.requestId }),
    }));
    expect(authorization.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      executionContext,
      requestId: executionContext.requestId,
      threadId: executionContext.threadId,
      runId: executionContext.runId,
    }));
  });

  it("denies when an installed trusted-context resolver returns no identity", async () => {
    const authorization = createAuthorizationConfig("allow");
    const executor = new GovernanceExecutor(
      createEchoTool("ok"),
      { ...defaultToolPolicy("contract_echo"), audit: false },
      { ...authorization.config, resolveExecutionContext: () => null }
    );
    await expect(executor.executeTyped({ value: "valid" })).resolves.toMatchObject({
      type: "denied_by_authorization",
      errorCode: "AUTHORIZATION_UNAVAILABLE",
    });
    expect(authorization.authorize).not.toHaveBeenCalled();
  });

  it("returns a typed authorization denial without dispatch", async () => {
    const invoked = vi.fn(async () => "unexpected");
    const sourceTool = tool(invoked, {
      name: "contract_echo",
      description: "Must not dispatch after denial.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const authorization = createAuthorizationConfig("deny");
    const executor = new GovernanceExecutor(
      sourceTool,
      { ...defaultToolPolicy(sourceTool.name), audit: false },
      authorization.config
    );

    await expect(executor.executeTyped({ value: "valid" })).resolves.toEqual({
      type: "denied_by_authorization",
      errorCode: "MISSING_ROLE_SCOPE_GRANT",
      decisionId: "decision-deny",
    });
    expect(invoked).not.toHaveBeenCalled();
    expect(authorization.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          decisionId: "decision-deny",
          effect: "deny",
        }),
      })
    );
  });

  it("fails closed without dispatch when decision persistence fails", async () => {
    const invoked = vi.fn(async () => "unexpected");
    const sourceTool = tool(invoked, {
      name: "contract_echo",
      description: "Must persist authorization before dispatch.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const authorization = createAuthorizationConfig("allow");
    authorization.recordDecision.mockRejectedValueOnce(
      new Error("decision store unavailable")
    );
    const executor = new GovernanceExecutor(
      sourceTool,
      { ...defaultToolPolicy(sourceTool.name), audit: false },
      authorization.config
    );

    await expect(executor.executeTyped({ value: "valid" })).resolves.toMatchObject({
      type: "denied_by_authorization",
      errorCode: "AUTHORIZATION_UNAVAILABLE",
    });
    expect(invoked).not.toHaveBeenCalled();
  });

  it("persists correlation before dispatch and redacts it through the decision store", async () => {
    const invoked = vi.fn(async () => "ok");
    const sourceTool = tool(invoked, {
      name: "contract_echo",
      description: "Persists its authorization decision before dispatch.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const authorization = createAuthorizationConfig("allow");
    const executor = new GovernanceExecutor(
      sourceTool,
      { ...defaultToolPolicy(sourceTool.name), audit: false },
      authorization.config
    );

    await executor.executeTyped(
      { value: "valid" },
      {
        configurable: {
          requestId: "request-1",
          threadId: "thread-1",
          runId: "run-1",
          taskId: "task-1",
          stepId: "step-1",
          toolExecutionId: "execution-1",
        },
      }
    );

    expect(authorization.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        policyVersion: "runtime-authorization-v1",
        taskId: "task-1",
        stepId: "step-1",
        toolExecutionId: "execution-1",
      })
    );
    expect(
      authorization.recordDecision.mock.invocationCallOrder[0]
    ).toBeLessThan(invoked.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });

  it("enters the injected HITL bridge and does not dispatch", async () => {
    const invoked = vi.fn(async () => "unexpected");
    const sourceTool = tool(invoked, {
      name: "contract_echo",
      description: "Waits for confirmation before dispatch.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const onRequireConfirmation = vi.fn(async (decision, request) =>
      createConfirmationRequiredDescriptor({
        decisionId: decision.decisionId,
        executionContext,
        action: request.action,
        toolName: "contract_echo",
        resource: request.resource,
        policyVersion: "runtime-authorization-v1",
        timeoutMs: 60_000,
      })
    );
    const authorization = createAuthorizationConfig(
      "require_confirmation",
      onRequireConfirmation
    );
    const executor = new GovernanceExecutor(
      sourceTool,
      { ...defaultToolPolicy(sourceTool.name), audit: false },
      authorization.config
    );

    await expect(executor.executeTyped({ value: "valid" })).resolves.toMatchObject({
      type: "confirmation_required",
      decisionId: "decision-require_confirmation",
      descriptor: {
        schemaVersion: "1.0",
        decisionId: "decision-require_confirmation",
      },
    });
    expect(onRequireConfirmation).toHaveBeenCalledOnce();
    expect(invoked).not.toHaveBeenCalled();
  });

  it("does not let sensitive confirmation override an authorization deny", async () => {
    const invoked = vi.fn(async () => "unexpected");
    const sourceTool = tool(invoked, {
      name: "contract_echo",
      description: "Must remain denied before confirmation.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const onRequireConfirmation = vi.fn(async (decision, request) =>
      createConfirmationRequiredDescriptor({
        decisionId: decision.decisionId,
        executionContext,
        action: request.action,
        toolName: "contract_echo",
        resource: request.resource,
        policyVersion: "runtime-authorization-v1",
        timeoutMs: 60_000,
      })
    );
    const authorization = createAuthorizationConfig(
      "deny",
      onRequireConfirmation,
      "sensitive"
    );
    const executor = new GovernanceExecutor(
      sourceTool,
      { ...defaultToolPolicy(sourceTool.name), audit: false },
      authorization.config
    );

    await expect(executor.executeTyped({ value: "valid" })).resolves.toEqual({
      type: "denied_by_authorization",
      errorCode: "MISSING_ROLE_SCOPE_GRANT",
      decisionId: "decision-deny",
    });
    expect(onRequireConfirmation).not.toHaveBeenCalled();
    expect(invoked).not.toHaveBeenCalled();
  });

  it("maps typed authorization denial to a legacy string at the wrapper", async () => {
    vi.stubEnv("TOOL_AUDIT_ENABLED", "false");
    const invoked = vi.fn(async () => "unexpected");
    const sourceTool = tool(invoked, {
      name: "contract_echo",
      description: "Must expose a legacy-safe denial string.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const authorization = createAuthorizationConfig("deny");
    const [governedTool] = applyToolGovernance(
      [sourceTool],
      authorization.config
    );

    await expect(governedTool.invoke({ value: "valid" })).resolves.toContain(
      "MISSING_ROLE_SCOPE_GRANT"
    );
    expect(invoked).not.toHaveBeenCalled();
  });

  it("rejects oversized input before dispatch", async () => {
    const invoked = vi.fn(async () => "unexpected");
    const sourceTool = tool(invoked, {
      name: "contract_rejected",
      description: "Must not be invoked for oversized input.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const executor = new GovernanceExecutor(sourceTool, {
      ...defaultToolPolicy(sourceTool.name),
      audit: false,
      maxInputChars: 1,
    });

    await expect(executor.executeTyped({ value: "too large" })).resolves.toEqual({
      type: "rejected_before_dispatch",
      errorCode: "TOOL_INPUT_TOO_LARGE",
    });
    expect(invoked).not.toHaveBeenCalled();
  });

  it("preserves an explicit failed-not-committed outcome", async () => {
    const sourceTool = tool(
      async () => {
        throw new GovernedDispatchError(
          "failed_not_committed",
          "PROVIDER_REJECTED"
        );
      },
      {
        name: "contract_not_committed",
        description: "Reports a definitive downstream rejection.",
        schema: z.object({ value: z.string() }),
      }
    ) as StructuredToolInterface;
    const executor = new GovernanceExecutor(sourceTool, {
      ...defaultToolPolicy(sourceTool.name),
      audit: false,
    });

    await expect(executor.executeTyped({ value: "valid" })).resolves.toEqual({
      type: "failed_not_committed",
      errorCode: "PROVIDER_REJECTED",
    });
  });

  it("treats an unknown error after dispatch as ambiguous", async () => {
    const sourceTool = tool(
      async () => {
        throw new Error("response was lost");
      },
      {
        name: "contract_ambiguous",
        description: "Loses the downstream response.",
        schema: z.object({ value: z.string() }),
      }
    ) as StructuredToolInterface;
    const executor = new GovernanceExecutor(sourceTool, {
      ...defaultToolPolicy(sourceTool.name),
      audit: false,
    });

    await expect(executor.executeTyped({ value: "valid" })).resolves.toEqual({
      type: "ambiguous_after_dispatch",
      errorCode: "TOOL_EXECUTION_OUTCOME_UNKNOWN",
    });
  });

  it("distinguishes external cancellation before dispatch", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    const executor = new GovernanceExecutor(
      createEchoTool("unexpected"),
      { ...defaultToolPolicy("contract_echo"), audit: false }
    );

    await expect(
      executor.executeTyped(
        { value: "valid" },
        { signal: controller.signal }
      )
    ).resolves.toEqual({ type: "cancelled", dispatchState: "before" });
  });

  it("does not dispatch when cancellation races with listener registration", async () => {
    const controller = new AbortController();
    const invoked = vi.fn(async () => "unexpected");
    const sourceTool = tool(invoked, {
      name: "contract_cancel_race",
      description: "Must not run after cancellation wins the dispatch race.",
      schema: z.object({ value: z.string() }),
    }) as StructuredToolInterface;
    const tracer = createNoopOpikTracer();
    tracer.withToolSpan = async function abortBeforeOperation<T>(
      _metadata: ToolSpanMetadata,
      operation: () => Promise<T>
    ): Promise<T> {
      controller.abort(new Error("cancelled before dispatch"));
      return operation();
    };
    setOpikTracerForTests(tracer);
    const executor = new GovernanceExecutor(sourceTool, {
      ...defaultToolPolicy(sourceTool.name),
      audit: false,
    });

    await expect(
      executor.executeTyped(
        { value: "valid" },
        { signal: controller.signal }
      )
    ).resolves.toEqual({ type: "cancelled", dispatchState: "before" });
    expect(invoked).not.toHaveBeenCalled();
  });

  it("maps governance timeout after dispatch to ambiguous", async () => {
    vi.useFakeTimers();
    const waitingTool = tool(
      async () => new Promise<string>(() => undefined),
      {
        name: "contract_typed_timeout",
        description: "Never resolves.",
        schema: z.object({ value: z.string() }),
      }
    ) as StructuredToolInterface;
    const executor = new GovernanceExecutor(waitingTool, {
      ...defaultToolPolicy(waitingTool.name),
      audit: false,
      timeoutMs: 1_000,
    });

    const outcomePromise = executor.executeTyped({ value: "valid" });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(outcomePromise).resolves.toEqual({
      type: "ambiguous_after_dispatch",
      errorCode: "GOVERNANCE_TIMEOUT",
    });
  });
});
