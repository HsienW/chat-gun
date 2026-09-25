import {
  TOOL_RISK_TIERS,
  type ToolRiskTier,
} from "../authorization/tool-risk.js";
import type { RetryPolicy } from "../retry/retry-policy.js";
import type { SideEffectToolDescriptor } from "../side-effect/side-effect-descriptor.js";

export interface RuntimeSchemaParseSuccess<TValue> {
  success: true;
  data: TValue;
}

export interface RuntimeSchemaParseFailure {
  success: false;
  error: unknown;
}

export interface RuntimeSchema<TValue> {
  safeParse(
    value: unknown
  ): RuntimeSchemaParseSuccess<TValue> | RuntimeSchemaParseFailure;
}

export interface TimeoutPolicy {
  timeoutMs: number;
}

export interface ToolRateLimitPolicy {
  maxRequestsPerWindow: number;
  windowMs: number;
}

export interface ToolCircuitBreakerPolicy {
  failureThreshold: number;
  successThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxProbes: number;
}

export type InterruptBehavior =
  | "cancel_safe"
  | "finish_current"
  | "reconcile_first";

export interface RuntimeToolDescriptor<TInput = unknown, TOutput = unknown> {
  toolName: string;
  toolVersion: string;
  inputSchema: RuntimeSchema<TInput>;
  outputSchema: RuntimeSchema<TOutput>;
  riskTier: ToolRiskTier;
  isReadOnly: boolean;
  isConcurrencySafe(input: TInput): boolean;
  timeoutPolicy: TimeoutPolicy;
  retryPolicy: RetryPolicy;
  rateLimitPolicy?: ToolRateLimitPolicy;
  circuitBreakerPolicy?: ToolCircuitBreakerPolicy;
  interruptBehavior: InterruptBehavior;
  sideEffect?: SideEffectToolDescriptor<TInput, TOutput>;
}

export interface RuntimeToolIdentity {
  toolName: string;
  toolVersion: string;
}

const INTERRUPT_BEHAVIORS = new Set<InterruptBehavior>([
  "cancel_safe",
  "finish_current",
  "reconcile_first",
]);

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Runtime tool descriptor ${fieldName} is required`);
  }
}

function assertPositiveInteger(value: unknown, fieldName: string): void {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Runtime tool descriptor ${fieldName} must be a positive integer`);
  }
}

function assertRuntimeSchema(
  schema: unknown,
  fieldName: "inputSchema" | "outputSchema"
): asserts schema is RuntimeSchema<unknown> {
  if (
    schema === null ||
    typeof schema !== "object" ||
    !("safeParse" in schema) ||
    typeof schema.safeParse !== "function"
  ) {
    throw new Error(`Runtime tool descriptor ${fieldName} is required`);
  }
}

function validateDescriptor<TInput, TOutput>(
  identity: RuntimeToolIdentity,
  descriptor: RuntimeToolDescriptor<TInput, TOutput>
): void {
  assertNonEmptyString(identity.toolName, "registered toolName");
  assertNonEmptyString(identity.toolVersion, "registered toolVersion");
  assertNonEmptyString(descriptor.toolName, "toolName");
  assertNonEmptyString(descriptor.toolVersion, "toolVersion");

  if (
    descriptor.toolName !== identity.toolName ||
    descriptor.toolVersion !== identity.toolVersion
  ) {
    throw new Error("Runtime tool descriptor identity mismatch");
  }

  assertRuntimeSchema(descriptor.inputSchema, "inputSchema");
  assertRuntimeSchema(descriptor.outputSchema, "outputSchema");
  if (!TOOL_RISK_TIERS.includes(descriptor.riskTier)) {
    throw new Error("Runtime tool descriptor riskTier is invalid");
  }
  if (typeof descriptor.isReadOnly !== "boolean") {
    throw new Error("Runtime tool descriptor isReadOnly is required");
  }
  if (typeof descriptor.isConcurrencySafe !== "function") {
    throw new Error("Runtime tool descriptor isConcurrencySafe is required");
  }
  assertPositiveInteger(descriptor.timeoutPolicy?.timeoutMs, "timeoutPolicy.timeoutMs");
  assertPositiveInteger(descriptor.retryPolicy?.maxAttempts, "retryPolicy.maxAttempts");
  assertPositiveInteger(descriptor.retryPolicy?.maxElapsedMs, "retryPolicy.maxElapsedMs");
  if (!Array.isArray(descriptor.retryPolicy?.retryableCategories)) {
    throw new Error("Runtime tool descriptor retryPolicy.retryableCategories is required");
  }
  if (!INTERRUPT_BEHAVIORS.has(descriptor.interruptBehavior)) {
    throw new Error("Runtime tool descriptor interruptBehavior is invalid");
  }

  if (descriptor.rateLimitPolicy !== undefined) {
    assertPositiveInteger(
      descriptor.rateLimitPolicy.maxRequestsPerWindow,
      "rateLimitPolicy.maxRequestsPerWindow"
    );
    assertPositiveInteger(
      descriptor.rateLimitPolicy.windowMs,
      "rateLimitPolicy.windowMs"
    );
  }
  if (descriptor.circuitBreakerPolicy !== undefined) {
    assertPositiveInteger(
      descriptor.circuitBreakerPolicy.failureThreshold,
      "circuitBreakerPolicy.failureThreshold"
    );
    assertPositiveInteger(
      descriptor.circuitBreakerPolicy.successThreshold,
      "circuitBreakerPolicy.successThreshold"
    );
    assertPositiveInteger(
      descriptor.circuitBreakerPolicy.resetTimeoutMs,
      "circuitBreakerPolicy.resetTimeoutMs"
    );
    assertPositiveInteger(
      descriptor.circuitBreakerPolicy.halfOpenMaxProbes,
      "circuitBreakerPolicy.halfOpenMaxProbes"
    );
  }

  if (!descriptor.isReadOnly && descriptor.sideEffect === undefined) {
    throw new Error("Mutation runtime tool descriptor requires sideEffect");
  }
  if (descriptor.isReadOnly && descriptor.sideEffect !== undefined) {
    throw new Error("Read-only runtime tool descriptor must not define sideEffect");
  }
  if (
    descriptor.sideEffect !== undefined &&
    (descriptor.sideEffect.toolName !== descriptor.toolName ||
      descriptor.sideEffect.toolVersion !== descriptor.toolVersion)
  ) {
    throw new Error("Runtime tool side-effect descriptor identity mismatch");
  }
}

export class RuntimeToolDescriptorRegistry {
  private readonly descriptors = new Map<
    string,
    RuntimeToolDescriptor<unknown, unknown>
  >();

  register<TInput, TOutput>(
    identity: RuntimeToolIdentity,
    descriptor: RuntimeToolDescriptor<TInput, TOutput>
  ): void {
    validateDescriptor(identity, descriptor);
    if (this.descriptors.has(identity.toolName)) {
      throw new Error(`Duplicate runtime tool descriptor: ${identity.toolName}`);
    }

    // The registry erases generic parameters only after runtime identity and
    // schema validation. Callers must parse through the stored schemas before
    // invoking typed descriptor callbacks.
    this.descriptors.set(
      identity.toolName,
      descriptor as RuntimeToolDescriptor<unknown, unknown>
    );
  }

  resolve(toolName: string): RuntimeToolDescriptor<unknown, unknown> | null {
    return this.descriptors.get(toolName) ?? null;
  }

  list(): RuntimeToolDescriptor<unknown, unknown>[] {
    return [...this.descriptors.values()];
  }
}
