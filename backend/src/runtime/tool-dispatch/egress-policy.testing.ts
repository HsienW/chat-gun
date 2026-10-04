import {
  setEgressPolicyTestDependencies,
  type EgressConnect,
} from "./egress-policy.js";

function toFetchHeaders(headers: unknown): HeadersInit | undefined {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers;
  if (Array.isArray(headers)) {
    const pairs: [string, string][] = [];
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2) {
        throw new TypeError("Unsupported test egress header tuple");
      }
      pairs.push([String(entry[0]), String(entry[1])]);
    }
    return pairs;
  }
  if (headers !== null && typeof headers === "object") {
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, String(value)])
    );
  }
  throw new TypeError("Unsupported test egress headers");
}

const testConnect: EgressConnect = async (target, init, validateAddress) => {
  validateAddress(target.addresses[0].address);
  if (
    init.body !== undefined &&
    init.body !== null &&
    typeof init.body !== "string" &&
    !(init.body instanceof Uint8Array)
  ) {
    throw new TypeError("Unsupported test egress request body");
  }
  return globalThis.fetch(target.url.toString(), {
    ...(init.method ? { method: init.method } : {}),
    ...(init.headers ? { headers: toFetchHeaders(init.headers) } : {}),
    ...(init.body ? { body: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
    redirect: "manual",
  });
};

export function installEgressPolicyTestTransport(): void {
  setEgressPolicyTestDependencies({
    resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: testConnect,
  });
}
