import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import { loadConfig, type BffConfig } from "./config.js";
import {
  selectPrincipalResolver,
  type PrincipalContext,
  type PrincipalResolution,
  type PrincipalResolver,
} from "./identity.js";
import { BFF_ERROR_MESSAGES } from "./error-messages.js";
import {
  defaultOperationsMetricsAuthorizer,
  proxyOperationsMetrics,
  type OperationsMetricsAuthorizer,
} from "./metrics-proxy.js";
import {
  createBffAbortError,
  createBffErrorEnvelope,
  isBffAbortReason,
  type BffAbortReason,
} from "./errors.js";
import { closeRedis, getRedis } from "./redis-client.js";
import {
  InMemoryRateLimiterWrapper,
  RedisRateLimiter,
  type RateLimitDimension,
  type RateLimiter,
  type RedisEvalClient,
} from "./redis-rate-limit.js";
import { InMemoryRateLimiter } from "./rate-limit.js";
import { validateUploadPayload } from "./upload-security.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const ALLOWED_PROXY_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "traceparent",
  "tracestate",
  "user-agent",
  "x-api-key",
]);

type RequestContext = {
  requestId: string;
  startedAt: number;
  clientIp: string;
  userId: string;
  tenantId: string;
};

type TrustedRequestScope = {
  tenantId: string;
  principalId: string;
  routeNamespace: string;
};

type ValidatedIdempotencyHeader =
  | { ok: true; present: false }
  | { ok: true; present: true; clientKey: string }
  | {
      ok: false;
      errorCode:
        | "duplicate_idempotency_header"
        | "idempotency_alias_conflict"
        | "invalid_idempotency_key";
    };

type ValidatedActiveRunHint =
  | { ok: true; present: false }
  | { ok: true; present: true; runId: string; generation: string }
  | {
      ok: false;
      errorCode:
        | "duplicate_active_run_hint_header"
        | "incomplete_active_run_hint"
        | "invalid_active_run_hint";
    };

type StreamPipeResult = {
  completed: boolean;
  clientDisconnected: boolean;
};

export type ServerDependencies = {
  redisClient?: RedisEvalClient | null;
  closeRedis?: () => Promise<void>;
  principalResolver?: PrincipalResolver;
  operationsMetricsAuthorizer?: OperationsMetricsAuthorizer;
};

type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  resetAt: number | null;
  headerResetAt: number;
  limit: number;
};

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function getRawHeaderValues(req: IncomingMessage, name: string): string[] {
  const normalizedName = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === normalizedName) {
      values.push(req.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function validateIdempotencyHeader(
  req: IncomingMessage
): ValidatedIdempotencyHeader {
  const canonicalValues = getRawHeaderValues(req, "x-idempotency-key");
  const aliasValues = getRawHeaderValues(req, "idempotency-key");
  if (canonicalValues.length > 1 || aliasValues.length > 1) {
    return { ok: false, errorCode: "duplicate_idempotency_header" };
  }

  const canonicalValue = canonicalValues[0];
  const aliasValue = aliasValues[0];
  if (
    canonicalValue !== undefined &&
    aliasValue !== undefined &&
    canonicalValue !== aliasValue
  ) {
    return { ok: false, errorCode: "idempotency_alias_conflict" };
  }
  const clientKey = canonicalValue ?? aliasValue;
  if (clientKey === undefined) return { ok: true, present: false };
  if (
    clientKey.length < 1 ||
    clientKey.length > 256 ||
    !/^[A-Za-z0-9_\-:.]+$/.test(clientKey)
  ) {
    return { ok: false, errorCode: "invalid_idempotency_key" };
  }
  return { ok: true, present: true, clientKey };
}

function validateActiveRunHint(req: IncomingMessage): ValidatedActiveRunHint {
  const runIdValues = getRawHeaderValues(req, "x-active-run-id");
  const generationValues = getRawHeaderValues(
    req,
    "x-active-run-generation"
  );
  if (runIdValues.length > 1 || generationValues.length > 1) {
    return { ok: false, errorCode: "duplicate_active_run_hint_header" };
  }

  const runId = runIdValues[0];
  const generation = generationValues[0];
  if (runId === undefined && generation === undefined) {
    return { ok: true, present: false };
  }
  if (runId === undefined || generation === undefined) {
    return { ok: false, errorCode: "incomplete_active_run_hint" };
  }
  const parsedGeneration = Number(generation);
  if (
    runId.length < 1 ||
    runId.length > 256 ||
    !/^[A-Za-z0-9_\-:.]+$/.test(runId) ||
    !/^[1-9]\d*$/.test(generation) ||
    !Number.isSafeInteger(parsedGeneration)
  ) {
    return { ok: false, errorCode: "invalid_active_run_hint" };
  }
  return { ok: true, present: true, runId, generation };
}

function createTrustedRequestDedupKey(
  scope: TrustedRequestScope,
  clientKey: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.tenantId,
        scope.principalId,
        scope.routeNamespace,
        clientKey,
      ])
    )
    .digest("hex");
}

function getClientIp(req: IncomingMessage): string {
  const forwardedFor = getHeader(req, "x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() || "unknown";
  return req.socket.remoteAddress ?? "unknown";
}

function getRateLimitIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function getRequestId(req: IncomingMessage): string {
  return getHeader(req, "x-request-id") ?? crypto.randomUUID();
}

function getOrigin(req: IncomingMessage): string | undefined {
  return getHeader(req, "origin");
}

function isOriginAllowed(origin: string | undefined, config: BffConfig): boolean {
  if (!origin) return true;
  if (config.allowedOrigins.length === 0) return true;
  return config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin);
}

function applyCors(req: IncomingMessage, res: ServerResponse, config: BffConfig): void {
  const origin = getOrigin(req);
  if (!origin || !isOriginAllowed(origin, config)) return;

  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, idempotency-key, x-active-run-generation, x-active-run-id, x-api-key, x-idempotency-key, x-request-id, x-tenant-id, x-user-id"
  );
  res.setHeader(
    "access-control-allow-methods",
    "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS"
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  requestId?: string
): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(payload.byteLength));
  if (requestId) res.setHeader("x-request-id", requestId);
  res.end(payload);
}

async function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
  ctx: RequestContext
): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let closedBeforeComplete = false;
  const disconnectReason: BffAbortReason = {
    code: "client_disconnected",
    stage: "request_body",
    requestId: ctx.requestId,
  };
  const onClose = () => {
    if (!req.complete) closedBeforeComplete = true;
  };

  req.on("close", onClose);
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        const error = new Error("Request body too large");
        error.name = "PayloadTooLargeError";
        throw error;
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (closedBeforeComplete || !req.complete) {
      throw createBffAbortError(disconnectReason, error);
    }
    throw error;
  } finally {
    req.off("close", onClose);
  }

  if (closedBeforeComplete || !req.complete) {
    throw createBffAbortError(disconnectReason);
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function copyRequestHeaders(
  req: IncomingMessage,
  ctx: RequestContext,
  principal: PrincipalContext,
  routeNamespace: string,
  idempotencyHeader: Extract<ValidatedIdempotencyHeader, { ok: true }>,
  activeRunHint: Extract<ValidatedActiveRunHint, { ok: true }>,
  idempotencyTtlMs: number,
  legacyHeaderMode: boolean
): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName)) continue;
    if (!FORWARDED_REQUEST_HEADERS.has(lowerName)) continue;
    if (value === undefined) continue;

    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  headers.set("x-request-id", ctx.requestId);
  headers.set("x-bff-principal-id", principal.principalId);
  headers.set("x-bff-principal-type", principal.principalType);
  headers.set("x-bff-tenant-id", principal.tenantId);
  headers.set("x-bff-roles", principal.roles.join(","));
  headers.set("x-bff-scopes", principal.scopes.join(","));
  headers.set("x-bff-auth-source", principal.authSource);
  headers.set("x-bff-authenticated-at", principal.authenticatedAt);
  if (legacyHeaderMode) {
    headers.set("x-bff-user-id", principal.principalId);
  }
  if (idempotencyHeader.present) {
    const trustedScope: TrustedRequestScope = {
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      routeNamespace,
    };
    headers.set(
      "x-idempotency-key",
      createTrustedRequestDedupKey(
        trustedScope,
        idempotencyHeader.clientKey
      )
    );
    headers.set("x-bff-idempotency-ttl-ms", String(idempotencyTtlMs));
  }
  if (activeRunHint.present) {
    headers.set("x-active-run-id", activeRunHint.runId);
    headers.set("x-active-run-generation", activeRunHint.generation);
  }
  headers.set("x-forwarded-for", ctx.clientIp);
  headers.set("x-forwarded-host", getHeader(req, "host") ?? "unknown");
  headers.set("x-forwarded-proto", "http");

  return headers;
}

function copyResponseHeaders(upstream: Response, res: ServerResponse): void {
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  });
}

async function pipeWebResponseBody(
  body: ReadableStream<Uint8Array>,
  res: ServerResponse,
  options: {
    abortController: AbortController;
    disconnectReason: BffAbortReason;
  }
): Promise<StreamPipeResult> {
  const reader = body.getReader();
  let completed = false;
  let clientDisconnected = false;

  const onClose = () => {
    if (completed || res.writableEnded) return;
    clientDisconnected = true;
    if (!options.abortController.signal.aborted) {
      options.abortController.abort(options.disconnectReason);
    }
    void reader.cancel(options.disconnectReason).catch(() => undefined);
  };

  res.on("close", onClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientDisconnected || res.destroyed) break;
      if (value && !res.write(value)) {
        await new Promise<void>((resolve) => {
          const onDrain = () => {
            res.off("close", onClosed);
            resolve();
          };
          const onClosed = () => {
            res.off("drain", onDrain);
            resolve();
          };
          res.once("drain", onDrain);
          res.once("close", onClosed);
        });
      }
    }
    completed = !clientDisconnected;
    if (completed && !res.writableEnded) res.end();
    return { completed, clientDisconnected };
  } catch (error) {
    if (clientDisconnected) {
      throw createBffAbortError(options.disconnectReason, error);
    }
    const abortReason = getAbortReason(options.abortController.signal);
    if (abortReason) {
      throw createBffAbortError(abortReason, error);
    }
    throw error;
  } finally {
    res.off("close", onClose);
    reader.releaseLock();
  }
}

function buildUpstreamUrl(reqUrl: URL, baseUrl: URL): URL {
  const upstream = new URL(baseUrl);
  const strippedPath = reqUrl.pathname.replace(/^\/api\/langgraph\/?/, "/");
  upstream.pathname = path.posix.join(upstream.pathname, strippedPath);
  upstream.search = reqUrl.search;
  return upstream;
}

function buildUpstreamBaseUrls(config: BffConfig): URL[] {
  const urls = [new URL(config.langGraphApiUrl)];

  if (config.langGraphApiUrl.hostname === "127.0.0.1") {
    const fallbackBase = new URL(config.langGraphApiUrl);
    fallbackBase.hostname = "localhost";
    urls.push(fallbackBase);
  }

  return urls;
}

function buildUpstreamUrls(reqUrl: URL, config: BffConfig): URL[] {
  return buildUpstreamBaseUrls(config).map((baseUrl) =>
    buildUpstreamUrl(reqUrl, baseUrl)
  );
}

function logAudit(
  ctx: RequestContext,
  req: IncomingMessage,
  statusCode: number,
  extra: Record<string, unknown> = {}
): void {
  const durationMs = Date.now() - ctx.startedAt;
  console.info(
    JSON.stringify({
      event: "bff_request",
      requestId: ctx.requestId,
      method: req.method,
      path: req.url,
      statusCode,
      durationMs,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      clientIp: ctx.clientIp,
      ...extra,
    })
  );
}

function abortWithReason(
  abortController: AbortController,
  reason: BffAbortReason
): void {
  if (!abortController.signal.aborted) {
    abortController.abort(reason);
  }
}

function getAbortReason(signal: AbortSignal): BffAbortReason | undefined {
  return isBffAbortReason(signal.reason) ? signal.reason : undefined;
}

function getResponseContentType(res: ServerResponse): string {
  const value = res.getHeader("content-type");
  if (Array.isArray(value)) return value.join(",");
  return value ? String(value) : "";
}

function buildMetricsUpstreamUrl(config: BffConfig, reqUrl: URL): URL {
  const upstreamUrl = new URL(config.metricsBackendUrl);
  upstreamUrl.pathname = path.posix.join(upstreamUrl.pathname, "/metrics");
  upstreamUrl.search = reqUrl.search;
  return upstreamUrl;
}

function copyMetricsRequestHeaders(
  req: IncomingMessage,
  ctx: RequestContext
): Headers {
  const headers = new Headers();
  const accept = getHeader(req, "accept");
  if (accept) headers.set("accept", accept);
  headers.set("x-request-id", ctx.requestId);
  return headers;
}

async function proxyMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  ctx: RequestContext,
  config: BffConfig,
  principalResolution: PrincipalResolution
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" }, ctx.requestId);
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

  const upstreamUrl = buildMetricsUpstreamUrl(config, reqUrl);
  const abortController = new AbortController();
  const disconnectReason: BffAbortReason = {
    code: "client_disconnected",
    stage: "metrics_upstream_proxy",
    requestId: ctx.requestId,
  };
  const timeoutReason: BffAbortReason = {
    code: "bff_timeout",
    stage: "metrics_upstream_proxy",
    requestId: ctx.requestId,
  };
  const onClientDisconnect = () => {
    if (!res.writableEnded) abortWithReason(abortController, disconnectReason);
  };
  const timeout = setTimeout(
    () => abortWithReason(abortController, timeoutReason),
    config.upstreamTimeoutMs
  );
  res.once("close", onClientDisconnect);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers: copyMetricsRequestHeaders(req, ctx),
      signal: abortController.signal,
    });

    res.statusCode = upstreamResponse.status;
    res.statusMessage = upstreamResponse.statusText;
    res.setHeader("x-request-id", ctx.requestId);
    copyResponseHeaders(upstreamResponse, res);

    if (req.method === "HEAD" || !upstreamResponse.body) {
      res.end();
      return;
    }

    await pipeWebResponseBody(upstreamResponse.body, res, {
      abortController,
      disconnectReason,
    });
  } catch (error) {
    const abortReason = getAbortReason(abortController.signal);
    if (abortReason?.code === "client_disconnected") return;

    const normalizedError = abortReason
      ? createBffAbortError(abortReason, error)
      : error;
    const envelope = createBffErrorEnvelope(normalizedError, {
      stage: "metrics_upstream_proxy",
      provider: "MetricsBackend",
      message: abortReason
        ? "Metrics upstream timed out"
        : "Metrics upstream error",
      abortReason,
      details: {
        method: req.method,
        path: req.url,
        requestId: ctx.requestId,
      },
    });

    console.error(
      JSON.stringify({
        event: "bff_metrics_upstream_error",
        requestId: ctx.requestId,
        method: req.method,
        path: req.url,
        statusCode: statusForBffErrorCode(envelope.error.code),
        durationMs: Date.now() - ctx.startedAt,
        errorCode: envelope.error.code,
      })
    );

    if (!res.headersSent) {
      sendJson(
        res,
        statusForBffErrorCode(envelope.error.code),
        envelope,
        ctx.requestId
      );
    } else if (!res.destroyed && !res.writableEnded) {
      res.destroy();
    }
  } finally {
    clearTimeout(timeout);
    res.off("close", onClientDisconnect);
  }
}

function isSseResponse(res: ServerResponse): boolean {
  return getResponseContentType(res).toLowerCase().includes("text/event-stream");
}

function statusForBffErrorCode(code: string): number {
  if (code === "bff_timeout") return 504;
  return 502;
}

function diagnosticStatusForBffErrorCode(code: string): number {
  if (code === "client_disconnected" || code === "client_cancelled") return 499;
  return statusForBffErrorCode(code);
}

async function checkRedisRateLimit(
  limiter: RateLimiter,
  req: IncomingMessage,
  ctx: RequestContext,
  config: BffConfig,
  now: number
): Promise<RateLimitDecision | undefined> {
  const dimensions: RateLimitDimension[] = [
    {
      name: "user",
      windowMs: config.rateLimitUserWindowMs,
      maxRequests: config.rateLimitUserMaxRequests,
      extractKey: () => ctx.userId,
    },
    {
      name: "ip",
      windowMs: config.rateLimitIpWindowMs,
      maxRequests: config.rateLimitIpMaxRequests,
      extractKey: () => getRateLimitIp(req),
    },
  ].filter((dimension) => dimension.maxRequests > 0 && dimension.windowMs > 0);

  let selected: RateLimitDecision | undefined;
  for (const dimension of dimensions) {
    const result = await limiter.check(dimension, now);
    const decision = {
      ...result,
      headerResetAt: result.resetAt ?? now + dimension.windowMs,
      limit: dimension.maxRequests,
    };
    if (!decision.allowed) return decision;
    if (!selected || decision.remaining < selected.remaining) {
      selected = decision;
    }
  }
  return selected;
}

function checkLegacyRateLimit(
  limiter: InMemoryRateLimiter,
  ctx: RequestContext,
  config: BffConfig,
  now: number
): RateLimitDecision {
  const result = limiter.check(
    `${ctx.tenantId}:${ctx.userId}:${ctx.clientIp}`,
    now
  );
  return {
    ...result,
    headerResetAt: result.resetAt,
    limit: config.rateLimitMaxRequests,
  };
}

function applyRateLimitHeaders(
  res: ServerResponse,
  decision: RateLimitDecision
): void {
  res.setHeader("x-ratelimit-limit", String(decision.limit));
  res.setHeader("x-ratelimit-remaining", String(decision.remaining));
  res.setHeader(
    "x-ratelimit-reset",
    String(Math.ceil(decision.headerResetAt / 1_000))
  );
}

function safeStreamErrorMessage(code: string): string {
  if (code === "bff_timeout") return "LangGraph stream timed out";
  if (code === "client_disconnected") return "Client disconnected from stream";
  return "LangGraph stream ended with an error";
}

function writeSseErrorFrame(
  res: ServerResponse,
  envelope: ReturnType<typeof createBffErrorEnvelope>
): void {
  if (res.destroyed || res.writableEnded) return;
  const { rawMessage: _rawMessage, ...safeError } = envelope.error;
  const safeEnvelope = { error: safeError };

  res.write(`event: error\n`);
  res.write(`data: ${JSON.stringify(safeEnvelope)}\n\n`);
  res.end();
}

function getContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function checkLangGraphReady(config: BffConfig): Promise<{
  ok: boolean;
  status?: number;
  checkedUrls?: string[];
  error?: string;
}> {
  const readyUrls = buildUpstreamBaseUrls(config).map((baseUrl) => new URL("/ok", baseUrl));
  let lastError: unknown;
  let lastStatus: number | undefined;

  for (const readyUrl of readyUrls) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 3_000);

    try {
      const response = await fetch(readyUrl, {
        method: "GET",
        signal: abortController.signal,
      });

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          checkedUrls: readyUrls.map((url) => url.toString()),
        };
      }

      lastStatus = response.status;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    ok: false,
    status: lastStatus,
    checkedUrls: readyUrls.map((url) => url.toString()),
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

async function serveFrontend(
  reqUrl: URL,
  res: ServerResponse,
  config: BffConfig
): Promise<boolean> {
  if (!reqUrl.pathname.startsWith("/app")) return false;

  const relativePath = decodeURIComponent(
    reqUrl.pathname.replace(/^\/app\/?/, "") || "index.html"
  );
  const requestedPath = path.resolve(config.frontendDist, relativePath);
  const distRoot = path.resolve(config.frontendDist);
  const safePath = requestedPath.startsWith(distRoot)
    ? requestedPath
    : path.join(distRoot, "index.html");

  try {
    const file = await fs.readFile(safePath);
    res.statusCode = 200;
    res.setHeader("content-type", getContentType(safePath));
    res.end(file);
    return true;
  } catch {
    const indexPath = path.join(distRoot, "index.html");
    try {
      const file = await fs.readFile(indexPath);
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(file);
      return true;
    } catch {
      return false;
    }
  }
}

async function proxyLangGraph(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  ctx: RequestContext,
  config: BffConfig,
  principalResolution: PrincipalResolution
): Promise<void> {
  if (!ALLOWED_PROXY_METHODS.has(req.method ?? "")) {
    sendJson(res, 405, { error: "Method not allowed" }, ctx.requestId);
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

  const idempotencyHeader = validateIdempotencyHeader(req);
  if (!idempotencyHeader.ok) {
    sendJson(
      res,
      400,
      {
        error: {
          code: idempotencyHeader.errorCode,
          message: "Invalid idempotency header",
        },
      },
      ctx.requestId
    );
    return;
  }
  const activeRunHint = validateActiveRunHint(req);
  if (!activeRunHint.ok) {
    sendJson(
      res,
      400,
      {
        error: {
          code: activeRunHint.errorCode,
          message: "Invalid active-run hint",
        },
      },
      ctx.requestId
    );
    return;
  }
  const upstreamUrls = buildUpstreamUrls(reqUrl, config);
  let attemptedUpstreamUrl = upstreamUrls[0];
  let lastUpstreamError: unknown;
  let observedUpstreamStatus: number | undefined;

  try {
    const body = await readRequestBody(req, config.maxBodyBytes, ctx);
    const uploadValidationError = validateUploadPayload(body, {
      maxFiles: config.imageUploadMaxFiles,
      maxBytes: config.imageUploadMaxBytes,
      maxPixels: config.imageUploadMaxPixels,
      allowedExtensions: config.imageUploadAllowedExtensions,
      allowedMimeTypes: config.imageUploadAllowedMimeTypes,
      s3BucketUrl: config.imageUploadS3BucketUrl,
    });

    if (uploadValidationError) {
      const error = new Error(uploadValidationError);
      const envelope = createBffErrorEnvelope(error, {
        stage: "upload_preflight",
        provider: "bff",
        message: BFF_ERROR_MESSAGES.upload.rejectedByBff,
        details: {
          method: req.method,
          path: req.url,
          requestId: ctx.requestId,
        },
      });
      sendJson(res, 400, envelope, ctx.requestId);
      return;
    }

    let upstreamResponse: Response | undefined;
    let activeAbortController: AbortController | undefined;
    let activeTimeout: NodeJS.Timeout | undefined;
    let lastAbortReason: BffAbortReason | undefined;

    for (const upstreamUrl of upstreamUrls) {
      attemptedUpstreamUrl = upstreamUrl;
      const abortController = new AbortController();
      const disconnectReason: BffAbortReason = {
        code: "client_disconnected",
        stage: "langgraph_upstream_proxy",
        requestId: ctx.requestId,
      };
      const onClientDisconnect = () => {
        if (!res.writableEnded) {
          abortWithReason(abortController, disconnectReason);
        }
      };
      let timeoutReason: BffAbortReason = {
        code: "bff_timeout",
        stage: "langgraph_upstream_proxy",
        requestId: ctx.requestId,
      };
      const timeout = setTimeout(
        () => abortWithReason(abortController, timeoutReason),
        config.upstreamTimeoutMs
      );
      res.once("close", onClientDisconnect);

      try {
        upstreamResponse = await fetch(upstreamUrl, {
          method: req.method,
          headers: copyRequestHeaders(
            req,
            ctx,
            principalResolution.principal,
            reqUrl.pathname,
            idempotencyHeader,
            activeRunHint,
            config.idempotencyTtlMs,
            config.legacyHeaderMode
          ),
          body,
          signal: abortController.signal,
        });
        activeAbortController = abortController;
        activeTimeout = timeout;
        break;
      } catch (error) {
        lastAbortReason = getAbortReason(abortController.signal);
        lastUpstreamError = error;
        clearTimeout(timeout);
        if (lastAbortReason?.code === "client_disconnected") {
          break;
        }
      } finally {
        res.off("close", onClientDisconnect);
        if (!upstreamResponse) clearTimeout(timeout);
      }
    }

    if (!upstreamResponse) {
      if (lastAbortReason) {
        throw createBffAbortError(
          lastAbortReason,
          lastUpstreamError ?? new Error("LangGraph upstream fetch failed")
        );
      }
      throw lastUpstreamError ?? new Error("LangGraph upstream fetch failed");
    }

    res.statusCode = upstreamResponse.status;
    res.statusMessage = upstreamResponse.statusText;
    observedUpstreamStatus = upstreamResponse.status;
    res.setHeader("x-request-id", ctx.requestId);
    copyResponseHeaders(upstreamResponse, res);

    const responseBody = upstreamResponse.body;
    if (req.method === "HEAD" || !responseBody) {
      if (activeTimeout) clearTimeout(activeTimeout);
      res.end();
      return;
    }

    if (!activeAbortController) {
      throw new Error("LangGraph upstream response missing abort controller");
    }

    const streamAbortController = activeAbortController;
    const streamTimeoutReason: BffAbortReason = {
      code: "bff_timeout",
      stage: "langgraph_stream_proxy",
      requestId: ctx.requestId,
    };

    try {
      if (!streamAbortController.signal.aborted) {
        const timeoutReason = streamTimeoutReason;
        if (activeTimeout) {
          clearTimeout(activeTimeout);
          activeTimeout = setTimeout(
            () => abortWithReason(streamAbortController, timeoutReason),
            config.upstreamTimeoutMs
          );
        }
      }
      await pipeWebResponseBody(responseBody, res, {
        abortController: streamAbortController,
        disconnectReason: {
          code: "client_disconnected",
          stage: "langgraph_stream_proxy",
          requestId: ctx.requestId,
        },
      });
    } finally {
      if (activeTimeout) clearTimeout(activeTimeout);
    }
  } catch (error) {
    let abortReason =
      error instanceof Error && isBffAbortReason(error.cause)
        ? error.cause
        : undefined;
    if (!abortReason && res.headersSent) {
      abortReason = {
        code: "upstream_stream_error",
        stage: "langgraph_stream_proxy",
        requestId: ctx.requestId,
      };
    }
    console.error(
      JSON.stringify({
        event: "bff_upstream_error",
        requestId: ctx.requestId,
        method: req.method,
        path: req.url,
        statusCode: res.headersSent
          ? res.statusCode
          : diagnosticStatusForBffErrorCode(abortReason?.code ?? "upstream_error"),
        durationMs: Date.now() - ctx.startedAt,
        upstreamStatus: observedUpstreamStatus,
        upstreamUrl: attemptedUpstreamUrl?.toString(),
        attemptedUpstreamUrls: upstreamUrls.map((url) => url.toString()),
        errorCode: abortReason?.code,
        abortReasonCode: abortReason?.code,
        clientDisconnected: abortReason?.code === "client_disconnected",
        streamStarted: res.headersSent,
        headersSent: res.headersSent,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorCause:
          error instanceof Error && error.cause instanceof Error
            ? {
                name: error.cause.name,
                message: error.cause.message,
              }
            : undefined,
      })
    );

    if (error instanceof Error && error.name === "PayloadTooLargeError") {
      sendJson(res, 413, { error: "Request body too large" }, ctx.requestId);
      return;
    }

    const isAbort = error instanceof Error && error.name === "AbortError";
    const stage = res.headersSent
      ? "langgraph_stream_proxy"
      : "langgraph_upstream_proxy";
    const envelope = createBffErrorEnvelope(error, {
      stage,
      provider: "LangGraph",
      message: abortReason
        ? safeStreamErrorMessage(abortReason.code)
        : isAbort
          ? "LangGraph stream aborted"
          : res.headersSent
            ? "LangGraph stream ended with an error"
            : "LangGraph upstream error",
      abortReason,
      details: {
        upstreamUrl: attemptedUpstreamUrl?.toString(),
        attemptedUpstreamUrls: upstreamUrls.map((url) => url.toString()),
        method: req.method,
        path: req.url,
        requestId: ctx.requestId,
      },
    });

    if (envelope.error.code === "client_disconnected") return;

    if (res.headersSent) {
      if (isSseResponse(res)) {
        writeSseErrorFrame(res, envelope);
        return;
      }
      if (!res.destroyed && !res.writableEnded) res.destroy();
      return;
    }

    sendJson(res, statusForBffErrorCode(envelope.error.code), envelope, ctx.requestId);
  }
}

export function createServer(
  config = loadConfig(),
  dependencies: ServerDependencies = {}
): http.Server {
  const legacyRateLimiter = new InMemoryRateLimiter(
    config.rateLimitWindowMs,
    config.rateLimitMaxRequests
  );
  const redisClient = config.redisRateLimitUri
    ? dependencies.redisClient === undefined
      ? getRedis()
      : dependencies.redisClient
    : null;
  const redisRateLimiter = redisClient
    ? new RedisRateLimiter(
        redisClient,
        new InMemoryRateLimiterWrapper()
      )
    : undefined;
  const principalResolver =
    dependencies.principalResolver ?? selectPrincipalResolver(config);
  const operationsMetricsAuthorizer =
    dependencies.operationsMetricsAuthorizer ?? defaultOperationsMetricsAuthorizer;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://${getHeader(req, "host") ?? "localhost"}`);
    const ctx: RequestContext = {
      requestId: getRequestId(req),
      startedAt: Date.now(),
      clientIp: getClientIp(req),
      userId: "anonymous",
      tenantId: "public",
    };
    const principalResolution = principalResolver.resolve(req, config);
    if (principalResolution.ok) {
      ctx.userId = principalResolution.principal.principalId;
      ctx.tenantId = principalResolution.principal.tenantId;
    }

    res.on("finish", () => logAudit(ctx, req, res.statusCode));
    applyCors(req, res, config);
    res.setHeader("x-request-id", ctx.requestId);

    if (!isOriginAllowed(getOrigin(req), config)) {
      sendJson(res, 403, { error: "Origin not allowed" }, ctx.requestId);
      return;
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (reqUrl.pathname === "/api/health" || reqUrl.pathname === "/api/bff/health") {
      sendJson(
        res,
        200,
        {
          status: "ok",
          langGraphApiUrl: config.langGraphApiUrl.origin,
        },
        ctx.requestId
      );
      return;
    }

    if (reqUrl.pathname === "/api/ready" || reqUrl.pathname === "/api/bff/ready") {
      const upstream = await checkLangGraphReady(config);
      sendJson(
        res,
        upstream.ok ? 200 : 503,
        {
          status: upstream.ok ? "ready" : "not_ready",
          langGraphApiUrl: config.langGraphApiUrl.origin,
          upstream,
        },
        ctx.requestId
      );
      return;
    }

    const rateLimitNow = Date.now();
    const rateLimit = redisRateLimiter
      ? await checkRedisRateLimit(
          redisRateLimiter,
          req,
          ctx,
          config,
          rateLimitNow
        )
      : checkLegacyRateLimit(legacyRateLimiter, ctx, config, rateLimitNow);

    if (rateLimit) {
      applyRateLimitHeaders(res, rateLimit);
    }

    if (rateLimit && !rateLimit.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil(((rateLimit.resetAt ?? rateLimitNow) - rateLimitNow) / 1_000)
      );
      res.setHeader("retry-after", String(retryAfter));
      sendJson(
        res,
        429,
        { error: BFF_ERROR_MESSAGES.rateLimit.exceeded, retryAfter },
        ctx.requestId
      );
      return;
    }

    if (reqUrl.pathname.startsWith("/api/langgraph")) {
      await proxyLangGraph(
        req,
        res,
        reqUrl,
        ctx,
        config,
        principalResolution
      );
      return;
    }

    if (reqUrl.pathname === "/api/metrics") {
      await proxyMetrics(
        req,
        res,
        reqUrl,
        ctx,
        config,
        principalResolution
      );
      return;
    }

    if (reqUrl.pathname === "/api/operations/metrics") {
      await proxyOperationsMetrics(
        req,
        res,
        reqUrl,
        ctx,
        config,
        principalResolution,
        operationsMetricsAuthorizer
      );
      return;
    }

    if (await serveFrontend(reqUrl, res, config)) {
      return;
    }

    sendJson(res, 404, { error: "Not found" }, ctx.requestId);
  });

  if (redisClient) {
    const closeRedisClient = dependencies.closeRedis ?? closeRedis;
    server.once("close", () => {
      void closeRedisClient().catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "bff_rate_limit_redis_close_error",
            errorName: error instanceof Error ? error.name : "UnknownError",
          })
        );
      });
    });
  }

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = loadConfig();
  const server = createServer(config);

  server.listen(config.port, () => {
    console.info(
      JSON.stringify({
        event: "bff_started",
        port: config.port,
        langGraphApiUrl: config.langGraphApiUrl.toString(),
        frontendDist: config.frontendDist,
      })
    );
  });
}
