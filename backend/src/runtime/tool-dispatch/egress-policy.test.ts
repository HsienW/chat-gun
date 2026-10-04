import { describe, expect, it, vi } from "vitest";

import {
  EgressPolicyError,
  PUBLIC_INTERNET_DESTINATION,
  assertHttpUrl,
  createEgressPolicy,
  fetchWithValidatedRedirects,
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
