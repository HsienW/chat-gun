import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RateLimitSubjectResolver } from "../run-admission.js";

export const VISITOR_COOKIE = "__Host-demo-visitor";
export class VisitorSessionResolver implements RateLimitSubjectResolver {
  constructor(private readonly secret: string, private readonly lifetimeMs: number, private readonly now: () => number = Date.now) {}
  private sign(payload: string): string { return createHmac("sha256", this.secret).update(payload).digest("base64url"); }
  resolve(request: { principalId: string; cookie?: string }): { subject: string; setCookie?: string; event?: string } {
    const token = request.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${VISITOR_COOKIE}=`))?.slice(VISITOR_COOKIE.length + 1);
    const now = this.now();
    let event: string | undefined;
    if (token) {
      event = "visitor_session_invalid";
      try {
        const [payload, signature, extra] = token.split(".");
        const actual = Buffer.from(signature ?? "", "base64url"), expected = Buffer.from(this.sign(payload), "base64url");
        if (extra === undefined && actual.length === expected.length && timingSafeEqual(actual, expected)) {
          const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
          if (value && typeof value === "object") {
            const { sessionId, issuedAt, expiresAt } = Object.fromEntries(Object.entries(value));
            if (Object.keys(value).length === 3 && typeof sessionId === "string" && /^[0-9a-f-]{36}$/u.test(sessionId)
              && Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) && Number(issuedAt) <= now
              && Number(expiresAt) - Number(issuedAt) === this.lifetimeMs) {
              if (Number(expiresAt) > now) return { subject: sessionId };
              event = "visitor_session_expired";
            }
          }
        }
      } catch { /* Invalid cookies rotate; they never grant identity or permissions. */ }
    }
    const sessionId = randomUUID();
    const payload = Buffer.from(JSON.stringify({ sessionId, issuedAt: now, expiresAt: now + this.lifetimeMs })).toString("base64url");
    return { subject: sessionId, ...(event ? { event } : {}),
      setCookie: `${VISITOR_COOKIE}=${payload}.${this.sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(this.lifetimeMs / 1000)}` };
  }
}
