import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";

/**
 * SSRF protection. The worker POSTs to URLs that subscribers choose, so without checks a subscriber could make our
 * server call internal services (the database, cloud metadata at 169.254.169.254, admin ports on localhost).
 *
 * Two checks:
 *  1. at subscription time (validateWebhookUrl): scheme and a DNS resolution of the host;
 *  2. at send time, inside the HTTP connection's own DNS lookup (guardedLookup), so a hostname that resolved to a
 *     public address at signup but to a private one later (DNS rebinding) is still refused.
 * WEBHOOK_ALLOW_PRIVATE=true disables both, for local dev and the replay demo (mock receivers on the Docker network).
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12], // private
  ["192.168.0.0", 16], // private
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) blocked.addSubnet(net, prefix, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address); // IPv4-mapped IPv6
    return mapped ? blocked.check(mapped[1]!, "ipv4") : blocked.check(address, "ipv6");
  }
  return true; // not an IP at all: refuse
}

export class UnsafeUrlError extends Error {}

function resolveAll(host: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) =>
    lookup(host, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))),
  );
}

/** Subscription-time check. Throws UnsafeUrlError with a reason the API can return. */
export async function validateWebhookUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("only http(s) URLs are allowed");
  if (url.username || url.password) throw new UnsafeUrlError("credentials in the URL are not allowed");
  if (allowPrivate) return url;
  if (url.protocol !== "https:") throw new UnsafeUrlError("https is required");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveAll(host).catch(() => {
    throw new UnsafeUrlError(`cannot resolve ${host}`);
  });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError("URL resolves to a private, loopback or link-local address");
  }
  return url;
}

/**
 * Drop-in `lookup` for http(s).request: resolves normally, then refuses private addresses. Because this runs as
 * part of connecting, the address we check is the address we connect to.
 */
export function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || list.length === 0) {
      return callback(new UnsafeUrlError(`refusing to connect to private address ${bad?.address ?? "(none)"}`), "");
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}
