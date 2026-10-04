import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  Agent,
  buildConnector,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici";
import { z } from "zod";

import {
  egressRequirementsSchema,
  type EgressRequirements,
} from "./execution-profile.js";

export const EGRESS_POLICY_VERSION = "1.0" as const;
export const PUBLIC_INTERNET_DESTINATION =
  "validated-public-destination" as const;

export const egressPolicySchema = z
  .object({
    policyVersion: z.literal(EGRESS_POLICY_VERSION),
    defaultAction: z.literal("deny"),
    destinations: z.array(z.string().min(1)),
    protocols: z.array(z.enum(["http", "https"])),
  })
  .strict();

export type EgressPolicy = z.infer<typeof egressPolicySchema>;
export type EgressPolicyErrorCode =
  | "EGRESS_DENIED"
  | "EGRESS_POLICY_UNAVAILABLE";

export interface EgressDecision {
  decision: "allow" | "deny";
  reasonCode: string;
}

const egressDecisionStorage = new AsyncLocalStorage<
  (decision: EgressDecision) => void
>();

export async function runWithEgressDecisionCapture<TResult>(
  operation: () => Promise<TResult>,
  onDecision: (decision: EgressDecision) => void
): Promise<TResult> {
  return egressDecisionStorage.run(onDecision, operation);
}

function recordDecision(decision: EgressDecision): void {
  egressDecisionStorage.getStore()?.(decision);
}

export class EgressPolicyError extends Error {
  readonly name = "EgressPolicyError";

  constructor(
    readonly code: EgressPolicyErrorCode,
    readonly reasonCode: string,
    message: string
  ) {
    super(message);
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ValidatedEgressTarget {
  url: URL;
  addresses: readonly ResolvedAddress[];
}

export type EgressDnsResolver = (
  hostname: string
) => Promise<readonly ResolvedAddress[]>;

export type EgressConnect = (
  target: ValidatedEgressTarget,
  init: UndiciRequestInit,
  validateConnectedAddress: (address: string) => void
) => Promise<Response>;

export interface EgressPolicyDependencies {
  resolveDns?: EgressDnsResolver;
  connect?: EgressConnect;
  allowedPorts?: ReadonlySet<string>;
}

let testDependencies: EgressPolicyDependencies | undefined;

export function setEgressPolicyTestDependencies(
  dependencies: EgressPolicyDependencies | undefined
): void {
  if (process.env.VITEST !== "true") {
    throw new Error("Egress policy test dependencies are only available in Vitest");
  }
  testDependencies = dependencies;
}

const DEFAULT_ALLOWED_PORTS = new Set(["80", "443"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function deny(reasonCode: string, message: string): never {
  recordDecision({ decision: "deny", reasonCode });
  throw new EgressPolicyError("EGRESS_DENIED", reasonCode, message);
}

function canonicalHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

function getEffectivePort(url: URL): string {
  if (url.port.length > 0) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function parseIpv4(address: string): readonly number[] | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  const parsed = octets.map(Number);
  return parsed.every(
    (part, index) =>
      Number.isInteger(part) &&
      part >= 0 &&
      part <= 255 &&
      String(part) === octets[index]
  )
    ? parsed
    : null;
}

export function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (octets === null) return true;
  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv6(address: string): readonly number[] | null {
  const normalized = canonicalHostname(address).split("%")[0];
  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  const parseParts = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const result: number[] = [];
    for (const segment of part.split(":")) {
      if (segment.includes(".")) {
        const ipv4 = parseIpv4(segment);
        if (ipv4 === null) return null;
        result.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(segment)) return null;
      result.push(Number.parseInt(segment, 16));
    }
    return result;
  };

  const left = parseParts(halves[0]);
  const right = parseParts(halves[1] ?? "");
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

export function isPrivateIpv6(address: string): boolean {
  const segments = parseIpv6(address);
  if (segments === null || segments.length !== 8) return true;
  const isUnspecified = segments.every((segment) => segment === 0);
  const isLoopback =
    segments.slice(0, 7).every((segment) => segment === 0) &&
    segments[7] === 1;
  const isUniqueLocal = (segments[0] & 0xfe00) === 0xfc00;
  const isLinkLocal = (segments[0] & 0xffc0) === 0xfe80;
  const isMulticast = (segments[0] & 0xff00) === 0xff00;
  const isDocumentation = segments[0] === 0x2001 && segments[1] === 0x0db8;
  const isIpv4Mapped =
    segments.slice(0, 5).every((segment) => segment === 0) &&
    segments[5] === 0xffff;
  if (isIpv4Mapped) {
    const ipv4 = `${segments[6] >> 8}.${segments[6] & 0xff}.${
      segments[7] >> 8
    }.${segments[7] & 0xff}`;
    return isPrivateIpv4(ipv4);
  }
  return (
    isUnspecified ||
    isLoopback ||
    isUniqueLocal ||
    isLinkLocal ||
    isMulticast ||
    isDocumentation
  );
}

export function assertPublicIp(address: string): void {
  const normalized = canonicalHostname(address);
  const version = isIP(normalized);
  if (
    version === 0 ||
    (version === 4 && isPrivateIpv4(normalized)) ||
    (version === 6 && isPrivateIpv6(normalized))
  ) {
    deny("PRIVATE_ADDRESS", `Egress target is not a public IP address: ${address}`);
  }
}

export function createEgressPolicy(
  requirements: EgressRequirements
): EgressPolicy {
  const parsed = egressRequirementsSchema.parse(requirements);
  return egressPolicySchema.parse({
    policyVersion: EGRESS_POLICY_VERSION,
    defaultAction: "deny",
    destinations: parsed.destinations.map((destination) =>
      canonicalHostname(destination)
    ),
    protocols: parsed.protocols,
  });
}

async function defaultResolveDns(
  hostname: string
): Promise<readonly ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap(({ address, family }) =>
    family === 4 || family === 6 ? [{ address, family }] : []
  );
}

function assertUnambiguousRawUrl(rawUrl: string): void {
  const authorityStart = rawUrl.indexOf("://");
  const authorityRemainder =
    authorityStart === -1 ? rawUrl : rawUrl.slice(authorityStart + 3);
  const authorityEnd = authorityRemainder.search(/[/?#]/);
  const authority =
    authorityEnd === -1
      ? authorityRemainder
      : authorityRemainder.slice(0, authorityEnd);
  if (
    /[\\\u0000-\u0020]/.test(rawUrl) ||
    /%(?:2f|5c|40|3a)/i.test(authority)
  ) {
    deny("URL_PARSER_DISAGREEMENT", "Ambiguous URL encoding is not allowed");
  }
}

export async function assertHttpUrl(
  rawUrl: string,
  policy: EgressPolicy,
  dependencies: EgressPolicyDependencies = {}
): Promise<ValidatedEgressTarget> {
  const parsedPolicy = egressPolicySchema.parse(policy);
  assertUnambiguousRawUrl(rawUrl);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    deny("URL_INVALID", "Invalid egress URL");
  }
  const protocol = url.protocol.slice(0, -1);
  if (
    (protocol !== "http" && protocol !== "https") ||
    !parsedPolicy.protocols.includes(protocol)
  ) {
    deny("PROTOCOL_NOT_ALLOWED", `Egress protocol is not allowed: ${url.protocol}`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    deny("EMBEDDED_CREDENTIAL", "URLs with embedded credentials are not allowed");
  }

  const allowedPorts = dependencies.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const effectivePort = getEffectivePort(url);
  if (!allowedPorts.has(effectivePort)) {
    deny("PORT_NOT_ALLOWED", `Egress port is not allowed: ${effectivePort}`);
  }

  const hostname = canonicalHostname(url.hostname);
  if (hostname === "localhost") {
    deny("PRIVATE_ADDRESS", "localhost is not allowed");
  }
  const permitsPublicInternet = parsedPolicy.destinations.includes(
    PUBLIC_INTERNET_DESTINATION
  );
  if (!permitsPublicInternet && !parsedPolicy.destinations.includes(hostname)) {
    deny("DESTINATION_NOT_ALLOWED", `Egress destination is not allowed: ${hostname}`);
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 || ipVersion === 6) {
    assertPublicIp(hostname);
    recordDecision({ decision: "allow", reasonCode: "POLICY_ALLOWED" });
    return { url, addresses: [{ address: hostname, family: ipVersion }] };
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await (dependencies.resolveDns ?? defaultResolveDns)(hostname);
  } catch (error) {
    if (error instanceof EgressPolicyError) throw error;
    throw new EgressPolicyError(
      "EGRESS_POLICY_UNAVAILABLE",
      "DNS_RESOLUTION_FAILED",
      `Egress DNS resolution failed for ${hostname}`
    );
  }
  if (addresses.length === 0) {
    deny("DNS_EMPTY", `Egress DNS resolution returned no addresses: ${hostname}`);
  }
  for (const { address } of addresses) assertPublicIp(address);
  recordDecision({ decision: "allow", reasonCode: "POLICY_ALLOWED" });
  return { url, addresses };
}

const defaultConnect: EgressConnect = async (
  target,
  init,
  validateConnectedAddress
) => {
  const pinned = target.addresses[0];
  validateConnectedAddress(pinned.address);
  const connector = buildConnector({});
  const dispatcher = new Agent({
    connect(options, callback) {
      const requestedHostname = canonicalHostname(options.hostname);
      const expectedHostname = canonicalHostname(target.url.hostname);
      if (requestedHostname !== expectedHostname) {
        callback(
          new EgressPolicyError(
            "EGRESS_DENIED",
            "CONNECT_HOST_MISMATCH",
            "Connected hostname differs from the validated destination"
          ),
          null
        );
        return;
      }
      validateConnectedAddress(pinned.address);
      connector(
        {
          ...options,
          hostname: pinned.address,
          servername: expectedHostname,
        },
        callback
      );
    },
  });
  try {
    const response = await undiciFetch(target.url, {
      ...init,
      redirect: "manual",
      dispatcher,
    });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await dispatcher.close();
  }
};

export async function fetchWithValidatedRedirects(
  rawUrl: string | URL,
  init: UndiciRequestInit,
  policy: EgressPolicy,
  dependencies: EgressPolicyDependencies = {},
  maxRedirects = 3
): Promise<Response> {
  const effectiveDependencies = {
    ...testDependencies,
    ...dependencies,
  };
  let currentUrl = rawUrl.toString();
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const target = await assertHttpUrl(currentUrl, policy, effectiveDependencies);
    const response = await (effectiveDependencies.connect ?? defaultConnect)(
      target,
      { ...init, redirect: "manual" },
      assertPublicIp
    );
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    currentUrl = new URL(location, target.url).toString();
  }
  deny("TOO_MANY_REDIRECTS", `Too many redirects; maximum is ${maxRedirects}`);
}
