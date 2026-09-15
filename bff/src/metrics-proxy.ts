import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";

import type { BffConfig } from "./config.js";
import type { PrincipalContext, PrincipalResolution } from "./identity.js";

const METRICS_READ_SCOPE = "operations:metrics:read";
const METRICS_READER_ROLE = "operations-reader";
const ALLOWED_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "etag",
  "last-modified",
  "vary",
]);

export interface OperationsAuthorizationRequest {
  action: "operations.metrics.read";
  principal: PrincipalContext;
  resource: {
    resourceType: "runtime_metrics";
    resourceId: string;
    tenantId: string;
  };
  scope: {
    scopeType: "tenant";
    scopeId: string;
    tenantId: string;
  };
}

export interface OperationsAuthorizationDecision {
  effect: "allow" | "deny" | "require_confirmation";
  reasonCode: string;
}

export interface OperationsMetricsAuthorizer {
  authorize(
    request: OperationsAuthorizationRequest
  ): Promise<OperationsAuthorizationDecision>;
}

export const defaultOperationsMetricsAuthorizer: OperationsMetricsAuthorizer = {
  async authorize(request) {
    const { principal, resource, scope } = request;
    const hasTrustedPrincipalType =
      principal.principalType === "platform_staff" ||
      principal.principalType === "service";
    const hasConsistentTenant =
      principal.tenantId === resource.tenantId &&
      resource.tenantId === scope.tenantId;
    if (
      hasTrustedPrincipalType &&
      hasConsistentTenant &&
      hasMetricsGrant(principal)
    ) {
      return { effect: "allow", reasonCode: "POLICY_ALLOWED" };
    }
    return { effect: "deny", reasonCode: "ACTION_NOT_ALLOWED" };
  },
};

export interface OperationsMetricsRequestContext {
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

function isConfigured(
  config: BffConfig
): config is BffConfig & {
  operationsRuntimeDeploymentId: string;
  operationsTenantId: string;
  operationsScopeId: string;
} {
  return Boolean(
    config.operationsRuntimeDeploymentId &&
      config.operationsTenantId &&
      config.operationsScopeId
  );
}

function hasMetricsGrant(principal: PrincipalContext): boolean {
  return (
    principal.scopes.includes(METRICS_READ_SCOPE) ||
    principal.roles.includes(METRICS_READER_ROLE)
  );
}

function buildUpstreamUrl(config: BffConfig): URL {
  const upstreamUrl = new URL(config.metricsBackendUrl);
  upstreamUrl.pathname = path.posix.join(
    upstreamUrl.pathname,
    "/operations/metrics"
  );
  upstreamUrl.search = "";
  upstreamUrl.hash = "";
  return upstreamUrl;
}

function buildRequestHeaders(
  req: IncomingMessage,
  requestId: string
): Headers {
  const headers = new Headers();
  const accept = req.headers.accept;
  if (typeof accept === "string") headers.set("accept", accept);
  headers.set("x-request-id", requestId);
  return headers;
}

function copyResponseHeaders(response: Response, res: ServerResponse): void {
  for (const [name, value] of response.headers.entries()) {
    if (ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  }
}

async function streamResponseBody(
  body: ReadableStream<Uint8Array>,
  res: ServerResponse
): Promise<void> {
  const reader = body.getReader();
  try {
    while (!res.destroyed && !res.writableEnded) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await once(res, "drain");
    }
  } finally {
    if (!res.destroyed && !res.writableEnded) res.end();
    if (res.destroyed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function hasRequestBody(req: IncomingMessage): boolean {
  const contentLength = req.headers["content-length"];
  return (
    req.headers["transfer-encoding"] !== undefined ||
    (typeof contentLength === "string" && Number(contentLength) > 0)
  );
}

export async function proxyOperationsMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  ctx: OperationsMetricsRequestContext,
  config: BffConfig,
  principalResolution: PrincipalResolution,
  authorizer: OperationsMetricsAuthorizer
): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" }, ctx.requestId);
    return;
  }
  if (reqUrl.search || hasRequestBody(req)) {
    sendJson(res, 400, { error: "Invalid metrics request" }, ctx.requestId);
    return;
  }
  if (!principalResolution.ok) {
    sendJson(
      res,
      principalResolution.status,
      { error: principalResolution.message },
      ctx.requestId
    );
    return;
  }
  if (!isConfigured(config)) {
    sendJson(res, 503, { error: "Operations metrics unavailable" }, ctx.requestId);
    return;
  }

  const principal = principalResolution.principal;
  if (
    (principal.principalType !== "platform_staff" &&
      principal.principalType !== "service") ||
    principal.tenantId !== config.operationsTenantId ||
    !hasMetricsGrant(principal)
  ) {
    sendJson(res, 403, { error: "Forbidden" }, ctx.requestId);
    return;
  }

  let decision: OperationsAuthorizationDecision;
  try {
    decision = await authorizer.authorize({
      action: "operations.metrics.read",
      principal,
      resource: {
        resourceType: "runtime_metrics",
        resourceId: config.operationsRuntimeDeploymentId,
        tenantId: config.operationsTenantId,
      },
      scope: {
        scopeType: "tenant",
        scopeId: config.operationsScopeId,
        tenantId: config.operationsTenantId,
      },
    });
  } catch {
    sendJson(res, 403, { error: "Forbidden" }, ctx.requestId);
    return;
  }
  if (decision.effect !== "allow") {
    sendJson(res, 403, { error: "Forbidden" }, ctx.requestId);
    return;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error("operations metrics timeout")),
    config.upstreamTimeoutMs
  );
  const onClose = () => {
    if (!res.writableEnded) {
      abortController.abort(new Error("operations metrics client disconnected"));
    }
  };
  res.once("close", onClose);

  try {
    const response = await fetch(buildUpstreamUrl(config), {
      method: "GET",
      headers: buildRequestHeaders(req, ctx.requestId),
      signal: abortController.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (
      !response.ok ||
      (!contentType.includes("application/openmetrics-text") &&
        !contentType.includes("text/plain"))
    ) {
      await response.body?.cancel().catch(() => undefined);
      sendJson(res, 502, { error: "Metrics upstream failure" }, ctx.requestId);
      return;
    }

    res.statusCode = response.status;
    res.setHeader("x-request-id", ctx.requestId);
    copyResponseHeaders(response, res);
    if (!response.body) {
      res.end();
      return;
    }
    await streamResponseBody(response.body, res);
  } catch {
    if (res.destroyed || res.writableEnded) return;
    sendJson(
      res,
      abortController.signal.aborted ? 504 : 502,
      { error: "Metrics upstream failure" },
      ctx.requestId
    );
  } finally {
    clearTimeout(timeout);
    res.off("close", onClose);
  }
}
