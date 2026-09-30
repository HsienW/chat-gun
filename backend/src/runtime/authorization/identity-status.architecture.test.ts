import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./identity-status.ts", import.meta.url), "utf8");

describe("identity status architecture", () => {
  it("keeps backend identity access read-only and provider-agnostic", () => {
    expect(source).toContain("SELECT status FROM identity_accounts");
    expect(source).toContain("SELECT status FROM identity_sessions");
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
    expect(source).not.toMatch(/jose|jwtVerify|provider.?claim/i);
    expect(source).not.toMatch(/principalType\s*===/);
  });
});
