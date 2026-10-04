import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EgressPolicyError,
  setEgressPolicyTestDependencies,
} from "../runtime/tool-dispatch/egress-policy.js";
import { withResolvedSecrets } from "../runtime/tool-dispatch/secret-broker.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";

describe("built-in network tool egress enforcement", () => {
  beforeEach(() => {
    setEgressPolicyTestDependencies({
      resolveDns: async () => [{ address: "10.0.0.8", family: 4 }],
      connect: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        })
      )
    );
  });

  afterEach(() => {
    setEgressPolicyTestDependencies(undefined);
    vi.unstubAllGlobals();
  });

  it("blocks web_fetch before a private resolved address can connect", async () => {
    await expect(
      webFetchTool.invoke({ url: "https://public.example/" })
    ).rejects.toMatchObject({ code: "EGRESS_DENIED" });
  });

  it("reports the validated input URL without reparsing it on success", async () => {
    setEgressPolicyTestDependencies({
      resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: vi.fn(async () =>
        new Response("ok", {
          headers: { "content-type": "text/plain" },
        })
      ),
    });

    const inputUrl = "https://public.example:443/path";
    const result = await webFetchTool.invoke({ url: inputUrl });

    expect(result).toContain(`Fetched URL: ${inputUrl}`);
  });

  it("blocks web_search before a private resolved address can connect", async () => {
    const config = withResolvedSecrets({}, {
      "env:TAVILY_API_KEY": "test-secret-value",
    });
    await expect(
      webSearchTool.invoke({ query: "security" }, config)
    ).rejects.toBeInstanceOf(EgressPolicyError);
  });
});
