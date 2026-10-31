import { Agent, fetch as undiciFetch } from "undici";
import { describe, expect, it, vi } from "vitest";

import {
  EgressPolicyError,
  PUBLIC_INTERNET_DESTINATION,
  assertHttpUrl,
  assertPublicIp,
  createEgressPolicy,
  createPinnedConnector,
  fetchWithValidatedRedirects,
  restoreEgressPolicyError,
  runWithEgressDecisionCapture,
  type EgressConnect,
} from "./egress-policy.js";

const publicInternetPolicy = createEgressPolicy({
  destinations: [PUBLIC_INTERNET_DESTINATION],
  protocols: ["http", "https"],
});

const fixedPolicy = createEgressPolicy({
  destinations: ["allowed.example"],
  protocols: ["https"],
});

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("versioned egress policy", () => {
  it("captures allow and deny decisions as audit evidence", async () => {
    const decisions: unknown[] = [];
    await runWithEgressDecisionCapture(
      () =>
        assertHttpUrl("https://allowed.example/", fixedPolicy, {
          resolveDns: publicLookup,
        }),
      (decision) => decisions.push(decision)
    );
    expect(decisions).toEqual([
      { decision: "allow", reasonCode: "POLICY_ALLOWED" },
    ]);

    decisions.length = 0;
    await runWithEgressDecisionCapture(
      () => assertHttpUrl("https://93.184.216.34/", publicInternetPolicy),
      (decision) => decisions.push(decision)
    );
    expect(decisions).toEqual([
      { decision: "allow", reasonCode: "POLICY_ALLOWED" },
    ]);
  });

  it("rejects URL parser disagreement inputs", async () => {
    await expect(
      assertHttpUrl("https://allowed.example\\@127.0.0.1/", fixedPolicy, {
        resolveDns: publicLookup,
      })
    ).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    await expect(
      assertHttpUrl("https://allowed.example%2f@denied.example/", fixedPolicy, {
        resolveDns: publicLookup,
      })
    ).rejects.toMatchObject({ reasonCode: "URL_PARSER_DISAGREEMENT" });
  });

  it.each([
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::ffff:127.0.0.1]/",
  ])("rejects encoded loopback IP %s", async (url) => {
    await expect(assertHttpUrl(url, publicInternetPolicy)).rejects.toBeInstanceOf(
      EgressPolicyError
    );
  });

  it("rejects localhost and any private DNS result", async () => {
    await expect(
      assertHttpUrl("https://localhost/", publicInternetPolicy)
    ).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    await expect(
      assertHttpUrl("https://public.example/", publicInternetPolicy, {
        resolveDns: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.8", family: 4 },
        ],
      })
    ).rejects.toMatchObject({ reasonCode: "PRIVATE_ADDRESS" });
  });

  it("revalidates the actual connect address and blocks DNS rebinding", async () => {
    const connect: EgressConnect = vi.fn(
      async (_target, _init, validateConnectedAddress) => {
        validateConnectedAddress("127.0.0.1");
        return new Response("must not return");
      }
    );

    await expect(
      fetchWithValidatedRedirects(
        "https://allowed.example/",
        {},
        fixedPolicy,
        { resolveDns: publicLookup, connect }
      )
    ).rejects.toMatchObject({ reasonCode: "PRIVATE_ADDRESS" });
  });

  it("classifies a DNS failure as unavailable without exposing the hostname", async () => {
    const decisions: unknown[] = [];
    const failure = await runWithEgressDecisionCapture(
      () =>
        assertHttpUrl("https://allowed.example/", fixedPolicy, {
          resolveDns: async () => {
            throw new Error("getaddrinfo ENOTFOUND allowed.example");
          },
        }),
      (decision) => decisions.push(decision)
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "EGRESS_POLICY_UNAVAILABLE",
      reasonCode: "DNS_RESOLUTION_FAILED",
    });
    expect((failure as Error).message).not.toContain("allowed.example");
    expect(decisions).toEqual([
      { decision: "unavailable", reasonCode: "DNS_RESOLUTION_FAILED" },
    ]);
  });

  it("keeps the denial and records it when real undici wraps a connector failure", async () => {
    const decisions: unknown[] = [];
    const dispatcher = new Agent({
      connect: createPinnedConnector(
        {
          url: new URL("https://allowed.example/"),
          addresses: [{ address: "93.184.216.34", family: 4 }],
        },
        assertPublicIp,
        (decision) => decisions.push(decision)
      ),
    });

    try {
      // The hostname differs from the validated target, so the connector rejects before any socket opens.
      const thrown = await undiciFetch("https://other.example/", { dispatcher }).catch(
        (error: unknown) => error
      );

      expect(thrown).toBeInstanceOf(TypeError);
      expect(restoreEgressPolicyError(thrown)).toMatchObject({
        name: "EgressPolicyError",
        code: "EGRESS_DENIED",
        reasonCode: "CONNECT_HOST_MISMATCH",
      });
      expect(decisions).toEqual([{ decision: "deny", reasonCode: "CONNECT_HOST_MISMATCH" }]);
    } finally {
      await dispatcher.close();
    }
  });

  it("leaves other errors unchanged when restoring an egress failure", () => {
    const error = new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    expect(restoreEgressPolicyError(error)).toBe(error);
  });

  it("replaces an earlier allow when DNS fails on a redirect hop", async () => {
    const decisions: unknown[] = [];
    const policy = createEgressPolicy({
      destinations: ["allowed.example", "next.example"],
      protocols: ["https"],
    });
    const connect: EgressConnect = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://next.example/" },
      });

    await expect(
      runWithEgressDecisionCapture(
        () =>
          fetchWithValidatedRedirects("https://allowed.example/", {}, policy, {
            resolveDns: async (hostname) => {
              if (hostname === "next.example") throw new Error("ENOTFOUND");
              return publicLookup();
            },
            connect,
          }),
        (decision) => decisions.push(decision)
      )
    ).rejects.toMatchObject({ code: "EGRESS_POLICY_UNAVAILABLE" });
    expect(decisions.at(-1)).toEqual({
      decision: "unavailable",
      reasonCode: "DNS_RESOLUTION_FAILED",
    });
  });

  it("denies a fake-ip resolution as a private address without exposing the IP", async () => {
    const failure = await assertHttpUrl("https://allowed.example/", fixedPolicy, {
      resolveDns: async () => [{ address: "198.18.0.71", family: 4 }],
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "EGRESS_DENIED", reasonCode: "PRIVATE_ADDRESS" });
    expect((failure as Error).message).not.toContain("198.18");
  });

  it.each([
    ["https://denied.example/", "DESTINATION_NOT_ALLOWED"],
    ["https://allowed.example:8443/", "PORT_NOT_ALLOWED"],
    ["http://allowed.example/", "PROTOCOL_NOT_ALLOWED"],
    ["https://user:pass@allowed.example/", "EMBEDDED_CREDENTIAL"],
  ])("keeps %s denied with reason %s and no destination in the message", async (url, reasonCode) => {
    const failure = await assertHttpUrl(url, fixedPolicy, {
      resolveDns: publicLookup,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "EGRESS_DENIED", reasonCode });
    expect((failure as Error).message).not.toMatch(/example|user|pass/);
  });

  it("denies an empty DNS answer as before", async () => {
    await expect(
      assertHttpUrl("https://allowed.example/", fixedPolicy, {
        resolveDns: async () => [],
      })
    ).rejects.toMatchObject({ code: "EGRESS_DENIED", reasonCode: "DNS_EMPTY" });
  });

  it("re-evaluates redirect targets and blocks allowlist escape", async () => {
    const connect: EgressConnect = vi.fn(async (target, _init, validate) => {
      validate(target.addresses[0].address);
      return new Response(null, {
        status: 302,
        headers: { location: "https://denied.example/secret" },
      });
    });

    await expect(
      fetchWithValidatedRedirects(
        "https://allowed.example/",
        {},
        fixedPolicy,
        { resolveDns: publicLookup, connect }
      )
    ).rejects.toMatchObject({ reasonCode: "DESTINATION_NOT_ALLOWED" });
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
