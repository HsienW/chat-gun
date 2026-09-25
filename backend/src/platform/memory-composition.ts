import { randomUUID } from "node:crypto";

import { MemoryContextProvider } from "../memory/context/memory-context-provider.js";
import {
  MemoryGovernanceService,
  type MemoryAuthorizer,
  type MemoryTelemetryEvent,
} from "../memory/governance/memory-governance-service.js";
import { MemoryWritePolicy } from "../memory/governance/write-policy.js";
import { InMemoryStoreAdapter } from "../memory/store/in-memory-adapter.js";
import { PostgresStoreAdapter } from "../memory/store/postgres-adapter.js";
import type { MemoryStorePort } from "../memory/store-port.js";
import { getDatabaseConnectionState } from "../runtime/persistence/connection.js";
import { getEnv } from "./env.js";
import { auditLogger } from "./observability.js";

export interface MemoryComposition {
  provider?: MemoryContextProvider;
  degradedReason?: "memory_disabled" | "memory_unavailable";
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = getEnv(name).trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function containsSensitiveData(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveData);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      /(api[-_]?key|authorization|credential|password|secret|token)/i.test(key) ||
      containsSensitiveData(entry)
  );
}

function createStore(): MemoryStorePort | undefined {
  if (getEnv("MEMORY_STORE_BACKEND", "memory").trim() !== "postgres") {
    return new InMemoryStoreAdapter();
  }
  const connection = getDatabaseConnectionState();
  if (!connection.configured) return undefined;
  return PostgresStoreAdapter.fromConnectionString({
    connectionString: connection.connectionString,
    schema: getEnv("MEMORY_STORE_SCHEMA", "public"),
    ensureTables: booleanEnv("MEMORY_STORE_ENSURE_TABLES", true),
  });
}

const sameScopeAuthorizer: MemoryAuthorizer = {
  async authorize(request) {
    const sameTenant =
      request.principal.tenantId === request.scope.tenantId &&
      request.principal.tenantId === request.resource.tenantId;
    const sameScope = request.resource.ownerScopeId === request.scope.scopeId;
    const allowed = request.action === "read" && sameTenant && sameScope;
    return {
      decisionId: randomUUID(),
      effect: allowed ? "allow" : "deny",
      reasonCode: allowed
        ? "POLICY_ALLOWED"
        : sameTenant
          ? "RESOURCE_OWNERSHIP_MISMATCH"
          : "CROSS_TENANT_DENIED",
      createdAt: new Date().toISOString(),
    };
  },
};

function recordMemoryTelemetry(event: MemoryTelemetryEvent): void {
  void auditLogger.record("memory.context", {
    kind: event.kind,
    reason: event.reason,
    tenantId: event.namespace.tenantId,
    scopeId: event.namespace.scopeId,
    ...(event.memoryId === undefined ? {} : { memoryId: event.memoryId }),
  });
}

function createComposition(): MemoryComposition {
  if (!booleanEnv("MEMORY_CONTEXT_ENABLED", true)) {
    return { provider: undefined, degradedReason: "memory_disabled" };
  }
  try {
    const store = createStore();
    if (!store) {
      void auditLogger.record("context.memory.degraded", {
        reasonCode: "memory_unavailable",
      });
      return { provider: undefined, degradedReason: "memory_unavailable" };
    }
    const governance = new MemoryGovernanceService({
      store,
      authorizer: sameScopeAuthorizer,
      writePolicy: new MemoryWritePolicy({
        sensitiveDataDetector: containsSensitiveData,
        minimumInferredConfidence: 0.8,
      }),
      relevance: {
        memoryTypeWeights: {
          preference: 1,
          negative_preference: 1,
          accepted_choice: 1,
          task_summary: 0.9,
          service_context: 0.8,
        },
        recencyHalfLifeMs: 30 * 24 * 60 * 60 * 1_000,
        maxCandidates: 20,
        maxTokens: 4_096,
        recallTimeoutMs: 1_000,
      },
      telemetry: recordMemoryTelemetry,
    });
    return { provider: new MemoryContextProvider(governance) };
  } catch (error) {
    void auditLogger.record("context.memory.degraded", {
      reasonCode: "memory_unavailable",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return { provider: undefined, degradedReason: "memory_unavailable" };
  }
}

let composition: MemoryComposition | undefined;

export function getMemoryComposition(): MemoryComposition {
  composition ??= createComposition();
  return composition;
}

export function resetMemoryCompositionForTests(): void {
  composition = undefined;
}
