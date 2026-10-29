import path from "node:path";

export const CLIENT_STATE_WRITE_FORBIDDEN = "CLIENT_STATE_WRITE_FORBIDDEN";

/**
 * The LangGraph route a BFF path reaches: prefix stripped, percent-encoding
 * decoded (except encoded slashes) and dot/duplicate segments collapsed, the
 * same way the upstream URL is built and routed. Matching the raw path would
 * let `//state` or `%73tate` slip past the guard.
 */
export function toLangGraphPath(pathname: string): string {
  const stripped = pathname.replace(/^\/api\/langgraph\/?/u, "/");
  let decoded = stripped;
  try {
    decoded = decodeURI(stripped);
  } catch {
    // Malformed encoding is rejected upstream; match on the raw form.
  }
  return path.posix.normalize(path.posix.join("/", decoded));
}

export type ClientStateWriteReason =
  | "thread_state_update"
  | "thread_create_supersteps"
  | "command_not_resume_only"
  | "input_command_representation";

export interface ClientStateWriteViolation {
  reason: ClientStateWriteReason;
  /** Route pattern only; never the concrete path, ids or body. */
  route: string;
}

/**
 * LangGraph API 1.4.5 surfaces that let a client write graph state directly.
 * Paths are relative to the LangGraph API root (the BFF strips /api/langgraph).
 * Re-check this list whenever the LangGraph API version changes.
 */
const STATE_WRITE_SURFACES = {
  threadStateUpdate: {
    pattern: /^\/threads\/[^/]+\/state\/?$/u,
    route: "/threads/{id}/state",
  },
  threadCreate: {
    pattern: /^\/threads\/?$/u,
    route: "/threads",
  },
} as const;

/**
 * LangGraph runs any input object carrying this serialization marker as a
 * Command, whatever its value, so run input must never carry it.
 */
const LANGGRAPH_SERIALIZATION_MARKER = "lg_name";

/** The only command field a client may send: resuming an interrupt. */
const CLIENT_COMMAND_FIELDS: ReadonlySet<string> = new Set(["resume"]);

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasPresteppedState(supersteps: unknown): boolean {
  if (supersteps === undefined || supersteps === null) return false;
  return !Array.isArray(supersteps) || supersteps.length > 0;
}

function isResumeOnlyCommand(command: unknown): boolean {
  if (command === undefined || command === null) return true;
  return (
    isRecord(command) &&
    Object.keys(command).every((field) => CLIENT_COMMAND_FIELDS.has(field))
  );
}

function parseBody(body: Buffer | undefined): unknown {
  if (!body?.length) return undefined;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    // Unparseable bodies keep the existing behavior and are left to upstream.
    return undefined;
  }
}

/**
 * Finds a request that would let the client write graph state or jump between
 * graph nodes. Read requests, ordinary run input and resume-only commands pass.
 */
export function findClientStateWrite(
  method: string | undefined,
  langGraphPath: string,
  body: Buffer | undefined
): ClientStateWriteViolation | undefined {
  const normalizedMethod = (method ?? "").toUpperCase();
  if (READ_ONLY_METHODS.has(normalizedMethod)) return undefined;

  if (STATE_WRITE_SURFACES.threadStateUpdate.pattern.test(langGraphPath)) {
    return {
      reason: "thread_state_update",
      route: `${normalizedMethod} ${STATE_WRITE_SURFACES.threadStateUpdate.route}`,
    };
  }

  const payload = parseBody(body);
  const requests = Array.isArray(payload) ? payload : [payload];

  if (
    STATE_WRITE_SURFACES.threadCreate.pattern.test(langGraphPath) &&
    requests.some((request) => isRecord(request) && hasPresteppedState(request.supersteps))
  ) {
    return {
      reason: "thread_create_supersteps",
      route: `${normalizedMethod} ${STATE_WRITE_SURFACES.threadCreate.route}`,
    };
  }

  // Every run-creating route (single, batch, crons) carries `command` at the
  // top level of each request, so the check does not depend on the path.
  if (requests.some((request) => isRecord(request) && !isResumeOnlyCommand(request.command))) {
    return {
      reason: "command_not_resume_only",
      route: `${normalizedMethod} ${toRoutePattern(langGraphPath)}`,
    };
  }
  if (
    requests.some(
      (request) =>
        isRecord(request) &&
        isRecord(request.input) &&
        LANGGRAPH_SERIALIZATION_MARKER in request.input
    )
  ) {
    return {
      reason: "input_command_representation",
      route: `${normalizedMethod} ${toRoutePattern(langGraphPath)}`,
    };
  }
  return undefined;
}

/** Literal LangGraph API path segments; anything else is an identifier. */
const ROUTE_LITERAL_SEGMENTS: ReadonlySet<string> = new Set([
  "threads", "runs", "stream", "wait", "batch", "crons", "state", "history",
  "checkpoint", "copy", "search", "count", "cancel", "join", "assistants",
  "store", "items", "namespaces",
]);

function toRoutePattern(langGraphPath: string): string {
  return langGraphPath
    .split("/")
    .map((segment) =>
      segment === "" || ROUTE_LITERAL_SEGMENTS.has(segment) ? segment : "{id}"
    )
    .join("/");
}
