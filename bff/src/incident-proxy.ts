import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

import type { BffConfig } from "./config.js";
import type { PrincipalContext, PrincipalResolution } from "./identity.js";

const INCIDENT_READ_SCOPE = "operations:incidents:read";
const INCIDENT_READER_ROLE = "operations-reader";
const MAX_INCIDENT_RESPONSE_BYTES = 1024 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,256}$/;
const DENIED_PROJECTION_FIELDS = /credential|password|secret|token|rawPrompt/i;

export interface OperationsIncidentAuthorizationRequest {
  action: "operations.incidents.read";
  principal: PrincipalContext;
  resource: {
    resourceType: "runtime_incident";
    resourceId: string;
    tenantId: string;
  };
  scope: { scopeType: "tenant"; scopeId: string; tenantId: string };
}

export interface OperationsIncidentAuthorizationDecision {
  effect: "allow" | "deny" | "require_confirmation";
  reasonCode: string;
}

export interface OperationsIncidentAuthorizer {
  authorize(
    request: OperationsIncidentAuthorizationRequest
  ): Promise<OperationsIncidentAuthorizationDecision>;
}

export const defaultOperationsIncidentAuthorizer: OperationsIncidentAuthorizer = {
  async authorize(request) {
    const principal = request.principal;
    const hasTrustedPrincipalType =
      principal.principalType === "platform_staff" ||
      principal.principalType === "service";
    const hasGrant =
      principal.scopes.includes(INCIDENT_READ_SCOPE) ||
      principal.roles.includes(INCIDENT_READER_ROLE);
    const hasConsistentTenant =
      principal.tenantId === request.resource.tenantId &&
      request.resource.tenantId === request.scope.tenantId;
    return hasTrustedPrincipalType && hasGrant && hasConsistentTenant
      ? { effect: "allow", reasonCode: "POLICY_ALLOWED" }
      : { effect: "deny", reasonCode: "ACTION_NOT_ALLOWED" };
  },
};

export interface OperationsIncidentRequestContext {
  requestId: string;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  requestId: string
): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-request-id", requestId);
  res.end(JSON.stringify(body));
}

function hasRequestBody(req: IncomingMessage): boolean {
  const contentLength = req.headers["content-length"];
  return (
    req.headers["transfer-encoding"] !== undefined ||
    (typeof contentLength === "string" && Number(contentLength) > 0)
  );
}

function isConfigured(
  config: BffConfig
): config is BffConfig & {
  operationsTenantId: string;
  operationsScopeId: string;
} {
  return Boolean(config.operationsTenantId && config.operationsScopeId);
}

function hasIncidentGrant(principal: PrincipalContext): boolean {
  return (
    principal.scopes.includes(INCIDENT_READ_SCOPE) ||
    principal.roles.includes(INCIDENT_READER_ROLE)
  );
}

function buildUpstreamUrl(config: BffConfig, runId: string): URL {
  const url = new URL(config.metricsBackendUrl);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/operations/incidents/${encodeURIComponent(runId)}`;
  url.search = "";
  url.hash = "";
  return url;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("INCIDENT_RESPONSE_BODY_MISSING");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_INCIDENT_RESPONSE_BYTES) {
        throw new Error("INCIDENT_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsDeniedField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDeniedField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) => DENIED_PROJECTION_FIELDS.test(key) || containsDeniedField(nested)
  );
}

function isIncidentProjection(value: unknown, runId: string): value is Record<string, unknown> {
  if (!isRecord(value) || value.schemaVersion !== "1.0" || value.runId !== runId) {
    return false;
  }
  if (
    !Array.isArray(value.events) ||
    !Array.isArray(value.audit) ||
    !Array.isArray(value.traces) ||
    !Array.isArray(value.toolExecutions) ||
    !(value.terminalResult === null || isRecord(value.terminalResult))
  ) {
    return false;
  }
  return !containsDeniedField(value);
}

export async function proxyOperationsIncident(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  runId: string,
  context: OperationsIncidentRequestContext,
  config: BffConfig,
  principalResolution: PrincipalResolution,
  authorizer: OperationsIncidentAuthorizer
): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" }, context.requestId);
    return;
  }
  if (!RUN_ID_PATTERN.test(runId) || reqUrl.search || hasRequestBody(req)) {
    sendJson(res, 400, { error: "Invalid incident request" }, context.requestId);
    return;
  }
  if (!principalResolution.ok) {
    sendJson(
      res,
      principalResolution.status,
      { error: principalResolution.message },
      context.requestId
    );
    return;
  }
  if (!isConfigured(config)) {
    sendJson(res, 503, { error: "Incident query unavailable" }, context.requestId);
    return;
  }
  const principal = principalResolution.principal;
  if (
    (principal.principalType !== "platform_staff" &&
      principal.principalType !== "service") ||
    principal.tenantId !== config.operationsTenantId ||
    !hasIncidentGrant(principal)
  ) {
    sendJson(res, 403, { error: "Forbidden" }, context.requestId);
    return;
  }
  let decision: OperationsIncidentAuthorizationDecision;
  try {
    decision = await authorizer.authorize({
      action: "operations.incidents.read",
      principal,
      resource: {
        resourceType: "runtime_incident",
        resourceId: runId,
        tenantId: config.operationsTenantId,
      },
      scope: {
        scopeType: "tenant",
        scopeId: config.operationsScopeId,
        tenantId: config.operationsTenantId,
      },
    });
  } catch {
    sendJson(res, 403, { error: "Forbidden" }, context.requestId);
    return;
  }
  if (decision.effect !== "allow") {
    sendJson(res, 403, { error: "Forbidden" }, context.requestId);
    return;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error("incident query timeout")),
    config.upstreamTimeoutMs
  );
  const onClose = () => {
    if (!res.writableEnded) {
      abortController.abort(new Error("incident query client disconnected"));
    }
  };
  res.once("close", onClose);
  try {
    const response = await fetch(buildUpstreamUrl(config, runId), {
      method: "GET",
      headers: { "x-request-id": context.requestId, accept: "application/json" },
      signal: abortController.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      sendJson(res, 502, { error: "Incident upstream failure" }, context.requestId);
      return;
    }
    const projection = await readBoundedJson(response);
    if (!isIncidentProjection(projection, runId)) {
      sendJson(res, 502, { error: "Incident upstream failure" }, context.requestId);
      return;
    }
    sendJson(res, 200, projection, context.requestId);
  } catch {
    if (!res.destroyed && !res.writableEnded) {
      sendJson(
        res,
        abortController.signal.aborted ? 504 : 502,
        { error: "Incident upstream failure" },
        context.requestId
      );
    }
  } finally {
    clearTimeout(timeout);
    res.off("close", onClose);
  }
}
