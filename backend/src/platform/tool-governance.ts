import {
  ToolInputParsingException,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";

import type {
  GovernedAuthorizationOutcome,
  GovernedToolExecutor,
  GovernedToolOutcome,
} from "../runtime/side-effect/governed-outcome.js";
import type {
  AuthorizationDecision,
  AuthorizationEngine,
  AuthorizationRequest,
} from "../runtime/authorization/authorization.js";
import type { DecisionStore } from "../runtime/authorization/decision-store.js";
import type { PrincipalContext } from "../runtime/authorization/principal.js";
import type { RuntimeScope } from "../runtime/authorization/scope.js";
import { readExecutionCorrelation } from "../runtime/execution-context/read-execution-context.js";
import { executionContextSchema, type ExecutionContext } from "../runtime/execution-context/execution-context.js";
import type {
  ToolRiskPolicy,
  ToolRiskRegistry,
} from "../runtime/authorization/tool-risk.js";
import { auditLogger, recordMetric } from "./observability.js";
import { getOpikTracer } from "./tracing/opik/opik-tracer.js";

export type {
  GovernedToolExecutor,
  GovernedToolOutcome,
} from "../runtime/side-effect/governed-outcome.js";

export interface ToolPolicy {
  enabled: boolean;
  audit: boolean;
  timeoutMs: number;
  maxInputChars: number;
  maxOutputChars: number;
  rateLimitKey?: string;
  grayReleaseKey?: string;
  circuitBreakerKey?: string;
}

export interface GovernedTool {
  tool: StructuredToolInterface;
  policy: ToolPolicy;
}

const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_INPUT_CHARS = 8_000;
const DEFAULT_MAX_OUTPUT_CHARS = 24_000;
const GOVERNANCE_TIMEOUT_PREFIX = "[governance_timeout]";
export const GOVERNANCE_CANCELLED_PREFIX = "[governance_cancelled]";
const governedTools = new WeakSet<object>();

type GovernedFailureType =
  | "rejected_before_dispatch"
  | "failed_not_committed"
  | "ambiguous_after_dispatch";

export class GovernedDispatchError extends Error {
  constructor(
    readonly outcomeType: GovernedFailureType,
    readonly errorCode: string
  ) {
    super(errorCode);
    this.name = "GovernedDispatchError";
  }
}

export interface ToolAuthorizationContext {
  principal: PrincipalContext;
  scope: RuntimeScope;
}

export interface ToolAuthorizationGovernanceConfig {
  riskRegistry: ToolRiskRegistry;
  authorizationEngine: Pick<AuthorizationEngine, "authorize">;
  decisionStore: DecisionStore;
  policyVersion?: string;
  /** X13 supplies this only after establishing the trusted Agent Server boundary. */
  resolveExecutionContext?: (
    config: unknown
  ) => ExecutionContext | null | Promise<ExecutionContext | null>;
  resolveContext?: (
    config: unknown
  ) => ToolAuthorizationContext | null | Promise<ToolAuthorizationContext | null>;
  resolveAction?: (
    input: unknown,
    config: unknown,
    policy: ToolRiskPolicy
  ) => string | null;
  onRequireConfirmation?: (
    decision: AuthorizationDecision,
    request: AuthorizationRequest
  ) => void | Promise<void>;
}

const DEFAULT_AUTHORIZATION_POLICY_VERSION = "runtime-authorization-v1";

interface DecisionCorrelation {
  requestId?: string;
  threadId?: string;
  runId?: string;
  taskId?: string;
  stepId?: string;
  toolExecutionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveDecisionCorrelation(config: unknown): DecisionCorrelation {
  return readExecutionCorrelation(config);
}

class GovernanceTimeoutError extends Error {
  readonly errorCode = "GOVERNANCE_TIMEOUT";

  constructor(timeoutMs: number, toolName: string) {
    super(
      `${GOVERNANCE_TIMEOUT_PREFIX} tool execution timed out after ${timeoutMs}ms: ${toolName}`
    );
    this.name = "GovernanceTimeoutError";
  }
}

class GovernanceCancellationError extends Error {
  constructor(readonly dispatchState: "before" | "after" | "unknown") {
    super("Tool execution cancelled by caller");
    this.name = "GovernanceCancellationError";
  }
}

function toolEnvName(toolName: string): string {
  return toolName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function parseCsvEnv(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function getIntEnv(name: string, fallback: number, min: number, max: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(Math.trunc(value), max));
}

function getBooleanEnv(name: string, fallback: boolean): boolean {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return fallback;
  }

  return rawValue.toLowerCase() === "true";
}

function serializeForLimit(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateOutput(toolName: string, output: unknown, maxOutputChars: number): unknown {
  const text = typeof output === "string" ? output : serializeForLimit(output);
  if (text.length <= maxOutputChars) {
    return output;
  }

  return `${text.slice(0, maxOutputChars)}\n\n[Tool output truncated by governance: ${toolName}, ${maxOutputChars} characters]`;
}

function getAbortSignal(config: unknown): AbortSignal | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const runnableConfig = config as RunnableConfig;
  const signal = runnableConfig.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function withGovernanceSignal(
  config: unknown,
  signal: AbortSignal
): RunnableConfig {
  const runnableConfig =
    config && typeof config === "object" ? (config as RunnableConfig) : {};
  const configurable = isRecord(runnableConfig.configurable)
    ? runnableConfig.configurable
    : {};
  const { abortSignal: _legacySignal, ...serializableConfigurable } = configurable;

  return {
    ...runnableConfig,
    signal,
    configurable: serializableConfigurable,
  };
}

function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  toolName: string,
  externalSignal?: AbortSignal
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  let rejectCancellation: ((error: GovernanceCancellationError) => void) | undefined;
  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
    return Promise.reject(new GovernanceCancellationError("before"));
  }
  const forwardExternalAbort = () => {
    controller.abort(externalSignal?.reason);
    rejectCancellation?.(new GovernanceCancellationError("after"));
  };
  externalSignal?.addEventListener("abort", forwardExternalAbort, { once: true });

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const timeoutError = new GovernanceTimeoutError(timeoutMs, toolName);
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });

  return Promise.race([
    operation(controller.signal),
    timeoutPromise,
    cancellationPromise,
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
    rejectCancellation = undefined;
    externalSignal?.removeEventListener("abort", forwardExternalAbort);
  });
}

function resolveToolPolicy(toolName: string): ToolPolicy {
  const envName = toolEnvName(toolName);
  const allowlist = parseCsvEnv("TOOL_ALLOWLIST");
  const denylist = parseCsvEnv("TOOL_DENYLIST");
  const explicitlyEnabled = getBooleanEnv(`TOOL_${envName}_ENABLED`, true);
  const allowedByList = allowlist.size === 0 || allowlist.has(toolName);
  const deniedByList = denylist.has(toolName);

  return {
    enabled: explicitlyEnabled && allowedByList && !deniedByList,
    audit: getBooleanEnv("TOOL_AUDIT_ENABLED", true),
    timeoutMs: getIntEnv(
      `TOOL_${envName}_TIMEOUT_MS`,
      getIntEnv("TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS, 1_000, 120_000),
      1_000,
      120_000
    ),
    maxInputChars: getIntEnv(
      `TOOL_${envName}_MAX_INPUT_CHARS`,
      getIntEnv("TOOL_MAX_INPUT_CHARS", DEFAULT_MAX_INPUT_CHARS, 1_000, 200_000),
      1_000,
      200_000
    ),
    maxOutputChars: getIntEnv(
      `TOOL_${envName}_MAX_OUTPUT_CHARS`,
      getIntEnv("TOOL_MAX_OUTPUT_CHARS", DEFAULT_MAX_OUTPUT_CHARS, 1_000, 200_000),
      1_000,
      200_000
    ),
  };
}

export function defaultToolPolicy(toolName = "tool"): ToolPolicy {
  return resolveToolPolicy(toolName);
}

async function auditToolEvent(
  eventName: string,
  policy: ToolPolicy,
  payload: Record<string, unknown>
): Promise<void> {
  if (!policy.audit) {
    return;
  }

  await auditLogger.record(eventName, payload);
}

function isToolInputValidationError(error: unknown): boolean {
  return (
    error instanceof ToolInputParsingException ||
    (error instanceof Error && error.name === "ZodError")
  );
}

function mapExecutionError<TResult>(
  error: unknown,
  wasDispatched: boolean,
  externalSignal?: AbortSignal
): Exclude<GovernedToolOutcome<TResult>, { type: "succeeded" }> {
  if (error instanceof GovernanceCancellationError || externalSignal?.aborted) {
    return {
      type: "cancelled",
      dispatchState: wasDispatched ? "after" : "before",
    };
  }
  if (error instanceof GovernanceTimeoutError) {
    return {
      type: "ambiguous_after_dispatch",
      errorCode: error.errorCode,
    };
  }
  if (error instanceof GovernedDispatchError) {
    return { type: error.outcomeType, errorCode: error.errorCode };
  }
  if (isToolInputValidationError(error)) {
    return {
      type: "rejected_before_dispatch",
      errorCode: "TOOL_INPUT_VALIDATION_FAILED",
    };
  }
  return wasDispatched
    ? {
        type: "ambiguous_after_dispatch",
        errorCode: "TOOL_EXECUTION_OUTCOME_UNKNOWN",
      }
    : {
        type: "rejected_before_dispatch",
        errorCode: "TOOL_EXECUTION_REJECTED",
      };
}

function legacyErrorForOutcome(
  toolName: string,
  outcome: Exclude<GovernedToolOutcome<unknown>, { type: "succeeded" }>,
  timeoutMs: number
): string {
  if (outcome.type === "cancelled") {
    return `Error: ${toolName} failed by tool governance - ${GOVERNANCE_CANCELLED_PREFIX} cancelled ${outcome.dispatchState} dispatch`;
  }
  if (outcome.errorCode === "GOVERNANCE_TIMEOUT") {
    return `Error: ${toolName} failed by tool governance - ${GOVERNANCE_TIMEOUT_PREFIX} tool execution timed out after ${timeoutMs}ms: ${toolName}`;
  }
  if (outcome.errorCode === "TOOL_INPUT_VALIDATION_FAILED") {
    return `Error: ${toolName} failed by tool governance - Received tool input did not match expected schema`;
  }
  if (outcome.errorCode === "TOOL_INPUT_TOO_LARGE") {
    return `Error: ${toolName} blocked by tool governance - input exceeds policy limit.`;
  }
  return `Error: ${toolName} failed by tool governance - ${outcome.errorCode}`;
}

function createDevelopmentAuthorizationContext(): ToolAuthorizationContext {
  return {
    principal: {
      principalId: "anonymous",
      principalType: "user",
      tenantId: "public",
      roles: [],
      scopes: [],
      authSource: "development",
      authenticatedAt: new Date().toISOString(),
    },
    scope: {
      scopeId: "development-public-anonymous",
      scopeType: "principal",
      tenantId: "public",
      ownerPrincipalId: "anonymous",
    },
  };
}

function authorizationDenial(
  errorCode: string,
  decisionId: string = globalThis.crypto.randomUUID()
): Extract<
  GovernedToolOutcome<never>,
  { type: "denied_by_authorization" }
> {
  return {
    type: "denied_by_authorization",
    errorCode,
    decisionId,
  };
}

function resolvePolicyAction(
  policy: ToolRiskPolicy,
  input: unknown,
  config: unknown,
  authorization: ToolAuthorizationGovernanceConfig
): string | null {
  const resolved = authorization.resolveAction?.(input, config, policy);
  if (resolved !== undefined) return resolved;
  return policy.actions.length === 1 ? policy.actions[0] ?? null : null;
}

async function authorizeToolDispatch(
  sourceTool: StructuredToolInterface,
  input: unknown,
  config: unknown,
  authorization: ToolAuthorizationGovernanceConfig
): Promise<GovernedAuthorizationOutcome> {
  const policy = authorization.riskRegistry.get(sourceTool.name);
  if (policy === null) {
    const classification = authorization.riskRegistry.classify(
      sourceTool.name,
      ""
    );
    return classification.effect === "allow"
      ? { type: "authorized" }
      : authorizationDenial(classification.reasonCode);
  }

  try {
    const action = resolvePolicyAction(policy, input, config, authorization);
    if (action === null) return authorizationDenial("TOOL_ACTION_AMBIGUOUS");

    const classification = authorization.riskRegistry.classify(
      sourceTool.name,
      action
    );
    if (classification.effect === "deny") {
      return authorizationDenial(classification.reasonCode);
    }

    const resolvedExecutionContext = await authorization.resolveExecutionContext?.(config);
    if (authorization.resolveExecutionContext && resolvedExecutionContext == null) {
      return authorizationDenial("AUTHORIZATION_UNAVAILABLE");
    }
    const executionContext = resolvedExecutionContext === undefined
      ? undefined
      : executionContextSchema.parse(resolvedExecutionContext);
    const context = executionContext
      ? { principal: executionContext.principal, scope: executionContext.scope }
      : (await authorization.resolveContext?.(config)) ??
        (process.env.NODE_ENV === "development"
          ? createDevelopmentAuthorizationContext()
          : null);
    if (context === null) return authorizationDenial("AUTHORIZATION_UNAVAILABLE");
    const correlation = executionContext ?? resolveDecisionCorrelation(config);
    const request: AuthorizationRequest = {
      principal: context.principal,
      scope: context.scope,
      action,
      resource: policy.resourceRefResolver(input, context.scope),
      context: { toolName: sourceTool.name, ...correlation },
    };
    const decision = await authorization.authorizationEngine.authorize(request);
    if (decision.effect === "deny") {
      await authorization.decisionStore.record({
        request,
        decision,
        policyVersion:
          authorization.policyVersion ?? DEFAULT_AUTHORIZATION_POLICY_VERSION,
        ...(executionContext ? { executionContext } : {}),
        ...correlation,
      });
      return authorizationDenial(decision.reasonCode, decision.decisionId);
    }
    const requiresConfirmation =
      decision.effect === "require_confirmation" ||
      classification.requiresConfirmation;
    if (requiresConfirmation) {
      const confirmationDecision: AuthorizationDecision = {
        ...decision,
        effect: "require_confirmation",
        reasonCode: "REQUIRES_CONFIRMATION",
      };
      await authorization.decisionStore.record({
        request,
        decision: confirmationDecision,
        policyVersion:
          authorization.policyVersion ?? DEFAULT_AUTHORIZATION_POLICY_VERSION,
        ...(executionContext ? { executionContext } : {}),
        ...correlation,
      });
      await authorization.onRequireConfirmation?.(
        confirmationDecision,
        request
      );
      return authorizationDenial(
        confirmationDecision.reasonCode,
        confirmationDecision.decisionId
      );
    }
    await authorization.decisionStore.record({
      request,
      decision,
      policyVersion:
        authorization.policyVersion ?? DEFAULT_AUTHORIZATION_POLICY_VERSION,
      ...(executionContext ? { executionContext } : {}),
      ...correlation,
    });
    return { type: "authorized", decisionId: decision.decisionId };
  } catch {
    return authorizationDenial("AUTHORIZATION_UNAVAILABLE");
  }
}

export class GovernanceExecutor<TResult = unknown>
  implements GovernedToolExecutor<unknown, TResult>
{
  constructor(
    private readonly sourceTool: StructuredToolInterface,
    private readonly policy: ToolPolicy,
    private readonly authorization?: ToolAuthorizationGovernanceConfig
  ) {}

  async executeTyped(
    input: unknown,
    config?: unknown
  ): Promise<GovernedToolOutcome<TResult>> {
    return this.executeInternal(input, config, false);
  }

  async authorizeTyped(
    input: unknown,
    config?: unknown
  ): Promise<GovernedAuthorizationOutcome> {
    return this.authorization === undefined
      ? { type: "authorized" }
      : authorizeToolDispatch(
          this.sourceTool,
          input,
          config,
          this.authorization
        );
  }

  async executeAuthorizedTyped(
    input: unknown,
    config?: unknown
  ): Promise<GovernedToolOutcome<TResult>> {
    return this.executeInternal(input, config, true);
  }

  private async executeInternal(
    input: unknown,
    config: unknown,
    authorizationAlreadyEvaluated: boolean
  ): Promise<GovernedToolOutcome<TResult>> {
    const startedAt = Date.now();
    const inputChars = serializeForLimit(input).length;
    const commonAuditPayload = {
      toolName: this.sourceTool.name,
      inputChars,
      timeoutMs: this.policy.timeoutMs,
      maxOutputChars: this.policy.maxOutputChars,
    };

    if (!this.policy.enabled) {
      return {
        type: "rejected_before_dispatch",
        errorCode: "TOOL_DISABLED_BY_POLICY",
      };
    }
    if (inputChars > this.policy.maxInputChars) {
      await auditToolEvent("tool.blocked", this.policy, {
        ...commonAuditPayload,
        reasonCode: "TOOL_INPUT_TOO_LARGE",
        maxInputChars: this.policy.maxInputChars,
      });
      return {
        type: "rejected_before_dispatch",
        errorCode: "TOOL_INPUT_TOO_LARGE",
      };
    }

    const externalSignal = getAbortSignal(config);
    if (externalSignal?.aborted) {
      return { type: "cancelled", dispatchState: "before" };
    }

    if (!authorizationAlreadyEvaluated) {
      const authorizationOutcome = await this.authorizeTyped(input, config);
      if (authorizationOutcome.type === "denied_by_authorization") {
        return authorizationOutcome;
      }
    }

    await auditToolEvent("tool.invoke.start", this.policy, commonAuditPayload);
    let wasDispatched = false;
    try {
      const { stepId, toolCallId } = readExecutionCorrelation(config);
      const result = await getOpikTracer().withToolSpan(
        {
          toolName: this.sourceTool.name,
          ...(stepId ? { stepId } : {}),
          ...(toolCallId ? { toolCallId } : {}),
        },
        () =>
          withTimeout(
            (signal) => {
              wasDispatched = true;
              return this.sourceTool.invoke(
                input as never,
                withGovernanceSignal(config, signal) as never
              ) as Promise<TResult>;
            },
            this.policy.timeoutMs,
            this.sourceTool.name,
            externalSignal
          ),
        input
      );
      const governedResult = truncateOutput(
        this.sourceTool.name,
        result,
        this.policy.maxOutputChars
      ) as TResult;
      const durationMs = Date.now() - startedAt;
      await auditToolEvent("tool.invoke.success", this.policy, {
        ...commonAuditPayload,
        outputChars: serializeForLimit(governedResult).length,
        durationMs,
      });
      await recordMetric("tool.invoke.duration_ms", {
        toolName: this.sourceTool.name,
        durationMs,
      });
      return { type: "succeeded", result: governedResult };
    } catch (error) {
      const outcome = mapExecutionError<TResult>(
        error,
        wasDispatched,
        externalSignal
      );
      const durationMs = Date.now() - startedAt;
      await auditToolEvent("tool.invoke.failure", this.policy, {
        ...commonAuditPayload,
        durationMs,
        outcomeType: outcome.type,
        ...(outcome.type === "cancelled"
          ? { dispatchState: outcome.dispatchState }
          : { errorCode: outcome.errorCode }),
      });
      await recordMetric("tool.invoke.failure.count", {
        toolName: this.sourceTool.name,
        outcomeType: outcome.type,
        count: 1,
      });
      return outcome;
    }
  }
}

function wrapToolWithGovernance(
  sourceTool: StructuredToolInterface,
  policy: ToolPolicy,
  authorization?: ToolAuthorizationGovernanceConfig
): StructuredToolInterface {
  if (governedTools.has(sourceTool as object)) {
    return sourceTool;
  }

  const wrappedTool = Object.assign(
    Object.create(Object.getPrototypeOf(sourceTool)) as StructuredToolInterface,
    sourceTool
  );
  const executor = new GovernanceExecutor(sourceTool, policy, authorization);
  const governedInvoke = async (input: unknown, config?: unknown): Promise<unknown> => {
    const outcome = await executor.executeTyped(input, config);
    return outcome.type === "succeeded"
      ? outcome.result
      : legacyErrorForOutcome(sourceTool.name, outcome, policy.timeoutMs);
  };

  wrappedTool.invoke = governedInvoke as StructuredToolInterface["invoke"];
  wrappedTool.call = governedInvoke as StructuredToolInterface["call"];

  governedTools.add(wrappedTool as object);
  return wrappedTool;
}

export function applyToolGovernance(
  tools: StructuredToolInterface[],
  authorization?: ToolAuthorizationGovernanceConfig
): StructuredToolInterface[] {
  return tools
    .map((tool) => ({ tool, policy: defaultToolPolicy(tool.name) }))
    .filter((entry) => entry.policy.enabled)
    .map((entry) =>
      wrapToolWithGovernance(entry.tool, entry.policy, authorization)
    );
}

export async function auditToolLoad(
  source: string,
  tools: StructuredToolInterface[]
): Promise<void> {
  await auditLogger.record("tool.load", {
    source,
    toolNames: tools.map((tool) => tool.name),
  });
  await recordMetric("tool.load.count", {
    source,
    count: tools.length,
  });
}
