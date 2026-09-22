import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";

import {
  SCOPE_TYPES,
  type ActiveScope,
  type ApiKeyPrincipalProfile,
} from "./identity.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultFrontendDist = path.resolve(dirname, "../../frontend/dist");
const MIN_IDEMPOTENCY_TTL_MS = 60_000;
const MAX_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60_000;

function readNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoundedNumber(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readCsv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

const PRINCIPAL_TYPES = [
  "user",
  "merchant_staff",
  "platform_staff",
  "service",
] as const;

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPrincipalType(
  value: unknown
): value is ApiKeyPrincipalProfile["principalType"] {
  return (
    typeof value === "string" &&
    PRINCIPAL_TYPES.some((principalType) => principalType === value)
  );
}

function parseActiveScope(value: unknown): ActiveScope | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (
    keys.some((key) => key !== "scopeId" && key !== "scopeType") ||
    typeof value.scopeId !== "string" ||
    value.scopeId.trim().length === 0 ||
    typeof value.scopeType !== "string" ||
    !SCOPE_TYPES.some((scopeType) => scopeType === value.scopeType)
  ) {
    return undefined;
  }
  return {
    scopeId: value.scopeId.trim(),
    scopeType: value.scopeType as ActiveScope["scopeType"],
  };
}

function isScopeCompatible(
  principalId: string,
  tenantId: string,
  activeScope: ActiveScope
): boolean {
  if (activeScope.scopeType === "principal") {
    return activeScope.scopeId === principalId;
  }
  if (activeScope.scopeType === "tenant") {
    return activeScope.scopeId === tenantId;
  }
  return true;
}

function normalizePermissionScopes(scopes: string[]): string[] | undefined {
  const normalized = scopes.map((scope) => scope.trim());
  if (normalized.some((scope) => scope.length === 0 || scope.includes(","))) {
    return undefined;
  }
  return [...new Set(normalized)];
}

function readApiKeyPrincipals(): Map<string, ApiKeyPrincipalProfile> {
  const raw = readOptionalString("BFF_API_KEY_PRINCIPALS_JSON");
  if (raw === undefined) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BFF_API_KEY_PRINCIPALS_JSON must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("BFF_API_KEY_PRINCIPALS_JSON must be an object");
  }

  const profiles = new Map<string, ApiKeyPrincipalProfile>();
  for (const [apiKey, value] of Object.entries(parsed)) {
    if (
      apiKey.trim().length === 0 ||
      !isRecord(value)
    ) {
      throw new Error("BFF_API_KEY_PRINCIPALS_JSON contains an invalid profile");
    }
    const candidate = value;
    const principalType = candidate.principalType;
    const activeScope = parseActiveScope(candidate.activeScope);
    const scopes = isStringArray(candidate.scopes)
      ? normalizePermissionScopes(candidate.scopes)
      : undefined;
    if (
      typeof candidate.principalId !== "string" ||
      candidate.principalId.trim().length === 0 ||
      !isPrincipalType(principalType) ||
      typeof candidate.tenantId !== "string" ||
      candidate.tenantId.trim().length === 0 ||
      !isStringArray(candidate.roles) ||
      scopes === undefined ||
      activeScope === undefined ||
      !isScopeCompatible(
        candidate.principalId.trim(),
        candidate.tenantId.trim(),
        activeScope
      )
    ) {
      throw new Error("BFF_API_KEY_PRINCIPALS_JSON contains an invalid profile");
    }
    profiles.set(apiKey, {
      principalId: candidate.principalId.trim(),
      principalType,
      tenantId: candidate.tenantId.trim(),
      roles: candidate.roles.map((role) => role.trim()),
      scopes,
      activeScope,
    });
  }
  return profiles;
}

export type BffConfig = {
  port: number;
  langGraphApiUrl: URL;
  metricsBackendUrl: URL;
  operationsRuntimeDeploymentId?: string;
  operationsTenantId?: string;
  operationsScopeId?: string;
  frontendDist: string;
  allowedOrigins: string[];
  requireAuth: boolean;
  apiKeys: Set<string>;
  apiKeyPrincipals: Map<string, ApiKeyPrincipalProfile>;
  legacyHeaderMode: boolean;
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
  idempotencyTtlMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  redisRateLimitUri?: string;
  rateLimitUserMaxRequests: number;
  rateLimitUserWindowMs: number;
  rateLimitIpMaxRequests: number;
  rateLimitIpWindowMs: number;
  imageUploadMaxFiles: number;
  imageUploadMaxBytes: number;
  imageUploadMaxPixels: number;
  imageUploadAllowedExtensions: Set<string>;
  imageUploadAllowedMimeTypes: Set<string>;
  imageUploadS3BucketUrl: string;
};

export function loadConfig(): BffConfig {
  const langGraphApiUrl = new URL(
    process.env.BFF_LANGGRAPH_API_URL ??
      process.env.LANGGRAPH_API_URL ??
      "http://localhost:2024"
  );
  const upstreamTimeoutMs = readNumber("BFF_UPSTREAM_TIMEOUT_MS", 120_000);
  const minimumIdempotencyTtlMs = Math.max(
    MIN_IDEMPOTENCY_TTL_MS,
    upstreamTimeoutMs
  );
  const maximumIdempotencyTtlMs = Math.max(
    MAX_IDEMPOTENCY_TTL_MS,
    minimumIdempotencyTtlMs
  );
  const defaultIdempotencyTtlMs = Math.max(
    DEFAULT_IDEMPOTENCY_TTL_MS,
    minimumIdempotencyTtlMs
  );

  const apiKeyPrincipals = readApiKeyPrincipals();
  return {
    port: readNumber("BFF_PORT", 8787),
    langGraphApiUrl,
    metricsBackendUrl: new URL(
      readOptionalString("AGENT_METRICS_BACKEND_URL") ?? langGraphApiUrl
    ),
    operationsRuntimeDeploymentId: readOptionalString(
      "BFF_OPERATIONS_RUNTIME_DEPLOYMENT_ID"
    ),
    operationsTenantId: readOptionalString("BFF_OPERATIONS_TENANT_ID"),
    operationsScopeId: readOptionalString("BFF_OPERATIONS_SCOPE_ID"),
    frontendDist:
      process.env.BFF_FRONTEND_DIST ??
      process.env.FRONTEND_DIST ??
      defaultFrontendDist,
    allowedOrigins: readCsv("BFF_ALLOWED_ORIGINS"),
    requireAuth: readBoolean("BFF_REQUIRE_AUTH", false),
    apiKeys: new Set([
      ...readCsv("BFF_API_KEYS"),
      ...apiKeyPrincipals.keys(),
    ]),
    apiKeyPrincipals,
    legacyHeaderMode: readBoolean("BFF_LEGACY_HEADER_MODE", true),
    maxBodyBytes: readNumber("BFF_MAX_BODY_BYTES", 50 * 1024 * 1024),
    upstreamTimeoutMs,
    idempotencyTtlMs: readBoundedNumber(
      "BFF_IDEMPOTENCY_TTL_MS",
      defaultIdempotencyTtlMs,
      minimumIdempotencyTtlMs,
      maximumIdempotencyTtlMs
    ),
    rateLimitWindowMs: readNumber("BFF_RATE_LIMIT_WINDOW_MS", 60_000),
    rateLimitMaxRequests: readNumber("BFF_RATE_LIMIT_MAX_REQUESTS", 120),
    redisRateLimitUri: readOptionalString("BFF_RATE_LIMIT_REDIS_URI"),
    rateLimitUserMaxRequests: readNumber(
      "BFF_RATE_LIMIT_USER_MAX_REQUESTS",
      30
    ),
    rateLimitUserWindowMs: readNumber("BFF_RATE_LIMIT_USER_WINDOW_MS", 60_000),
    rateLimitIpMaxRequests: readNumber("BFF_RATE_LIMIT_IP_MAX_REQUESTS", 20),
    rateLimitIpWindowMs: readNumber("BFF_RATE_LIMIT_IP_WINDOW_MS", 60_000),
    imageUploadMaxFiles: readNumber("BFF_IMAGE_UPLOAD_MAX_FILES", 6),
    imageUploadMaxBytes: readNumber("BFF_IMAGE_UPLOAD_MAX_BYTES", 5 * 1024 * 1024),
    imageUploadMaxPixels: readNumber("BFF_IMAGE_UPLOAD_MAX_PIXELS", 24_000_000),
    imageUploadAllowedExtensions: new Set(
      readCsv("BFF_IMAGE_UPLOAD_ALLOWED_EXTENSIONS").length
        ? readCsv("BFF_IMAGE_UPLOAD_ALLOWED_EXTENSIONS").map((value) => value.toLowerCase())
        : [".png", ".jpg", ".jpeg", ".webp"]
    ),
    imageUploadAllowedMimeTypes: new Set(
      readCsv("BFF_IMAGE_UPLOAD_ALLOWED_MIME_TYPES").length
        ? readCsv("BFF_IMAGE_UPLOAD_ALLOWED_MIME_TYPES").map((value) => value.toLowerCase())
        : ["image/png", "image/jpeg", "image/webp"]
    ),
    imageUploadS3BucketUrl: process.env.BFF_IMAGE_UPLOAD_S3_BUCKET_URL ?? "",
  };
}
