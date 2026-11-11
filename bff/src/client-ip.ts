import { BlockList, isIP } from "node:net";

export type ClientIpResolution = {
  clientIp: string;
  forwardingStatus: "peer" | "forwarded" | "invalid" | "all_trusted";
};

function addNetwork(list: BlockList, network: string): void {
  const parts = network.split("/");
  const address = parts[0];
  const version = isIP(address);
  if (!version || parts.length > 2) throw new Error("invalid_network");
  const family = version === 4 ? "ipv4" : "ipv6";
  if (parts.length === 1) {
    list.addAddress(address, family);
    return;
  }
  if (!/^\d+$/.test(parts[1])) throw new Error("invalid_prefix");
  const prefix = Number(parts[1]);
  if (prefix <= 0 || prefix > (version === 4 ? 32 : 128)) {
    throw new Error("unsafe_prefix");
  }
  list.addSubnet(address, prefix, family);
}

export function parseTrustedProxies(raw = ""): string[] {
  const networks = [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
  try {
    const list = new BlockList();
    for (const network of networks) addNetwork(list, network);
  } catch {
    throw new Error("invalid_configuration:BFF_TRUSTED_PROXIES");
  }
  return networks;
}

export function createClientIpResolver(networks: readonly string[]) {
  const list = new BlockList();
  for (const network of networks) addNetwork(list, network);
  const isTrusted = (address: string) => {
    const version = isIP(address);
    return version !== 0 && list.check(address, version === 4 ? "ipv4" : "ipv6");
  };
  return (peer = "unknown", forwardedFor?: string | string[]): ClientIpResolution => {
    if (!isTrusted(peer) || forwardedFor === undefined) {
      return { clientIp: peer, forwardingStatus: "peer" };
    }
    if (typeof forwardedFor !== "string") {
      return { clientIp: peer, forwardingStatus: "invalid" };
    }
    const chain = forwardedFor.split(",").map((part) => part.trim());
    if (chain.some((address) => !isIP(address))) {
      return { clientIp: peer, forwardingStatus: "invalid" };
    }
    for (let index = chain.length - 1; index >= 0; index--) {
      if (!isTrusted(chain[index])) {
        return { clientIp: chain[index], forwardingStatus: "forwarded" };
      }
    }
    return { clientIp: chain[0], forwardingStatus: "all_trusted" };
  };
}

export function resolveClientIp(
  peer: string,
  forwardedFor: string | string[] | undefined,
  networks: readonly string[]
): ClientIpResolution {
  return createClientIpResolver(networks)(peer, forwardedFor);
}
