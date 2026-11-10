import type { RunLease } from "./run-admission.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RUN_LOCATION = new RegExp(`^/threads/(${UUID})/runs/(${UUID})$`, "iu");
// LangGraph API 1.4.5 schemas.Run; unknown future statuses remain unconfirmed.
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["success", "error", "timeout", "interrupted"]);
type RunIdentity = { threadId: string; runId: string; url: string };
type FinishOutcome = "not_forwarded" | "completed" | "rejected" | "abnormal";
type LifecycleOptions = {
  leases: readonly RunLease[];
  acceptedAt: number;
  timeoutMs: number;
  requestId: string;
  fetcher?: typeof fetch;
  audit?: (event: string, fields: Record<string, string>) => void;
};

/** Only the verified relative Content-Location is accepted; it cannot choose a host. */
export function parseRunIdentity(location: string | null, upstream: URL): RunIdentity | undefined {
  const match = location ? RUN_LOCATION.exec(location) : null;
  if (!match) return undefined;
  const routeOffset = upstream.pathname.indexOf("/threads/");
  if (routeOffset < 0) return undefined;
  const requestedThread = upstream.pathname.slice(routeOffset).split("/")[2];
  if (requestedThread?.toLowerCase() !== match[1].toLowerCase()) return undefined;
  const url = new URL(upstream);
  url.pathname = upstream.pathname.slice(0, routeOffset) + match[0];
  url.search = "";
  url.hash = "";
  return { threadId: match[1], runId: match[2], url: url.toString() };
}

export class HeldRunLifecycle {
  readonly controller = new AbortController();
  readonly deadline: number;
  private readonly deadlineTimer: ReturnType<typeof setTimeout>;
  private identity?: RunIdentity;
  private headers = new Headers();
  private ending?: Promise<void>;

  constructor(private readonly options: LifecycleOptions) {
    this.deadline = options.acceptedAt + options.timeoutMs;
    this.deadlineTimer = setTimeout(() => this.controller.abort({
      code: "bff_timeout", stage: "langgraph_upstream_proxy", requestId: options.requestId,
    }), Math.max(0, this.deadline - Date.now()));
  }

  observeResponse(response: Response, upstream: URL, headers: Headers): void {
    this.identity = parseRunIdentity(response.headers.get("content-location"), upstream);
    this.headers = new Headers(headers);
  }

  finish(outcome: FinishOutcome): Promise<void> {
    return this.ending ??= Promise.resolve().then(() => this.finishOnce(outcome));
  }

  private audit(event: string, fields: Record<string, string> = {}): void {
    const payload = { requestId: this.options.requestId, ...fields };
    try {
      if (this.options.audit) this.options.audit(event, payload);
      else console.info(JSON.stringify({ event, ...payload }));
    } catch { /* Audit failures do not change lease ownership. */ }
  }

  private async release(): Promise<void> {
    for (const lease of new Set(this.options.leases)) {
      try { await lease.release(); }
      catch { this.audit("run_lease_release_failed"); }
    }
  }

  private async finishOnce(outcome: FinishOutcome): Promise<void> {
    clearTimeout(this.deadlineTimer);
    if (outcome !== "abnormal") { await this.release(); return; }
    // Transport must be stopped before a separate cancel request is sent.
    if (!this.controller.signal.aborted) this.controller.abort();
    if (!this.identity) { this.audit("run_lease_retained", { reason: "run_identity_unavailable" }); return; }
    const expiresAt = Math.min(...this.options.leases.map(lease => lease.expiresAt));
    const remaining = expiresAt - Date.now();
    if (!(remaining > 0)) { this.audit("run_lease_retained", { reason: "lease_expired" }); return; }
    const confirmation = new AbortController();
    const timeout = setTimeout(() => confirmation.abort(), remaining);
    const fetcher = this.options.fetcher ?? fetch;
    try {
      const cancel = new URL(this.identity.url + "/cancel");
      cancel.searchParams.set("action", "interrupt");
      cancel.searchParams.set("wait", "true");
      const response = await fetcher(cancel, { method: "POST", headers: this.headers, signal: confirmation.signal, redirect: "error" });
      if (response.status !== 204) { this.audit("run_lease_retained", { reason: "cancel_failed" }); return; }
      const statusResponse = await fetcher(this.identity.url, { headers: this.headers, signal: confirmation.signal, redirect: "error" });
      const status: unknown = statusResponse.ok ? await statusResponse.json() : undefined;
      if (!status || typeof status !== "object" || !("status" in status) || typeof status.status !== "string" || !TERMINAL_RUN_STATUSES.has(status.status)) {
        this.audit("run_lease_retained", { reason: "terminal_unconfirmed" });
        return;
      }
      this.audit("run_cancel_confirmed", { runId: this.identity.runId, status: status.status });
      await this.release();
    } catch {
      this.audit("run_lease_retained", { reason: "confirmation_failed" });
    } finally {
      clearTimeout(timeout);
    }
  }
}
