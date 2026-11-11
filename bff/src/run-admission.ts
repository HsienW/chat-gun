export const ADMISSION_ERRORS = Object.freeze({
  usage_budget_exhausted: { status: 503, message: "Usage budget exhausted", requiresRetryAfter: true },
  usage_budget_unavailable: { status: 503, message: "Usage budget unavailable", requiresRetryAfter: false },
  run_quota_exhausted: { status: 429, message: "Run quota exhausted", requiresRetryAfter: true },
  run_concurrency_limited: { status: 429, message: "Run concurrency limit reached", requiresRetryAfter: true },
  feature_disabled: { status: 403, message: "Feature is unavailable", requiresRetryAfter: false },
} as const);
export type AdmissionErrorCode = keyof typeof ADMISSION_ERRORS;
export type RunRouteKind = "background" | "stream" | "wait" | "batch" | "cron";
export type RunParameter = { state: "absent" } | { state: "unparseable" } | { state: "present"; value: unknown };
export type RunLifecycleParameters = { onDisconnect: RunParameter; afterSeconds: RunParameter; streamResumable: RunParameter };
export type RunAdmissionRequest = {
  routeKind: RunRouteKind;
  graphId?: string;
  threadId?: string;
  subject: string;
  clientIp: string;
  isResume: boolean;
  lifecycle: RunLifecycleParameters;
  signal?: AbortSignal;
};
export interface RunLease { acquiredAt?: number; expiresAt: number; release(): Promise<void> | void; }
export type RunAdmissionDecision =
  | { kind: "allow"; lease?: RunLease }
  | { kind: "deny"; code: AdmissionErrorCode; retryAfterSeconds?: number; budgetScope?: string };
export interface RunAdmissionPolicy { check(request: RunAdmissionRequest): Promise<RunAdmissionDecision> | RunAdmissionDecision; }
export interface RateLimitSubjectResolver {
  resolve(request: { principalId: string; cookie?: string }): { subject: string; setCookie?: string; event?: string };
}
export const ALLOW_ALL: RunAdmissionPolicy = Object.freeze({ check: () => ({ kind: "allow" as const }) });
export const PRINCIPAL_SUBJECT_RESOLVER: RateLimitSubjectResolver = Object.freeze({ resolve: ({ principalId }: { principalId: string }) => ({ subject: principalId }) });

const RUN_ROUTES: readonly { pattern: RegExp; kind: RunRouteKind }[] = [
  { pattern: /^\/(?:threads\/[^/]+\/)?runs\/stream\/?$/u, kind: "stream" },
  { pattern: /^\/(?:threads\/[^/]+\/)?runs\/wait\/?$/u, kind: "wait" },
  { pattern: /^\/(?:threads\/[^/]+\/)?runs\/batch\/?$/u, kind: "batch" },
  { pattern: /^\/(?:threads\/[^/]+\/)?runs\/?$/u, kind: "background" },
  { pattern: /^\/(?:threads\/[^/]+\/)?crons\/?$/u, kind: "cron" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parameter(payload: unknown, key: string): RunParameter {
  if (!isRecord(payload)) return { state: "unparseable" };
  return Object.hasOwn(payload, key) ? { state: "present", value: payload[key] } : { state: "absent" };
}

export function requestsForRun(method: string | undefined, pathname: string, body: Buffer | undefined, subject: { subject: string; clientIp: string }): RunAdmissionRequest[] {
  if (method !== "POST") return [];
  const route = RUN_ROUTES.find(candidate => candidate.pattern.test(pathname));
  if (!route) return [];
  let payload: unknown;
  try { payload = body?.length ? JSON.parse(body.toString("utf8")) : undefined; }
  catch { payload = undefined; }
  const threadId = /^\/threads\/([^/]+)\//u.exec(pathname)?.[1];
  const requests = route.kind === "batch" && Array.isArray(payload) && payload.length ? payload : [payload];
  return requests.map(request => ({
    ...subject, routeKind: route.kind, ...(threadId ? { threadId } : {}),
    ...(isRecord(request) && typeof request.assistant_id === "string" ? { graphId: request.assistant_id } : {}),
    isResume: isRecord(request) && isRecord(request.command) && Object.hasOwn(request.command, "resume"),
    lifecycle: { onDisconnect: parameter(request, "on_disconnect"), afterSeconds: parameter(request, "after_seconds"), streamResumable: parameter(request, "stream_resumable") },
  }));
}

export function validateAdmissionDecision(decision: unknown): decision is RunAdmissionDecision {
  if (!isRecord(decision)) return false;
  if (decision.kind === "allow") return decision.lease === undefined || (isRecord(decision.lease) && typeof decision.lease.release === "function" && typeof decision.lease.expiresAt === "number" && Number.isSafeInteger(decision.lease.expiresAt) && decision.lease.expiresAt > Date.now());
  if (decision.kind !== "deny" || typeof decision.code !== "string" || !Object.hasOwn(ADMISSION_ERRORS, decision.code)) return false;
  const definition = Object.entries(ADMISSION_ERRORS).find(([code]) => code === decision.code)?.[1];
  if (!definition) return false;
  if (definition.requiresRetryAfter && decision.retryAfterSeconds === undefined) return false;
  if (decision.retryAfterSeconds !== undefined && (typeof decision.retryAfterSeconds !== "number" || !Number.isSafeInteger(decision.retryAfterSeconds) || decision.retryAfterSeconds <= 0)) return false;
  return decision.budgetScope === undefined || (typeof decision.budgetScope === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(decision.budgetScope));
}
