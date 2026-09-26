import { lookup } from "dns/promises";
import { isIP } from "net";

/**
 * Validate that a URL is a well-formed http/https URL whose resolved
 * hostname does not point at private, loopback, link-local, or metadata
 * address ranges. This is a defense-in-depth SSRF guard: the server must
 * never make outbound requests to internal infrastructure on behalf of a
 * caller.
 *
 * Returns the normalized URL string on success, or throws an Error with a
 * human-readable message describing why the URL was rejected.
 */
export async function validatePublicUrl(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("url must be a valid http/https URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must be a valid http/https URL");
  }

  if (!parsed.hostname) {
    throw new Error("url must include a hostname");
  }

  // A literal IP hostname needs no DNS lookup — check it directly. (Node
  // returns bracketed IPv6 hostnames, e.g. "[::1]", so strip the brackets.)
  const literalHost = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literalHost) !== 0) {
    if (isForbiddenAddress(literalHost)) {
      throw new Error("url must not point to a private, loopback, link-local, or metadata address");
    }
    return normalizedUrlString(parsed);
  }

  // Resolve the hostname to every address it currently maps to and reject if
  // any of them is in a forbidden range. We check all addresses because a
  // hostname could resolve to a mix of public and private IPs.
  let addresses: string[];
  try {
    const result = await lookup(parsed.hostname, { all: true });
    addresses = result.map((entry) => entry.address);
  } catch {
    throw new Error("url hostname could not be resolved");
  }

  if (addresses.length === 0) {
    throw new Error("url hostname could not be resolved");
  }

  for (const address of addresses) {
    if (isForbiddenAddress(address)) {
      throw new Error("url must not point to a private, loopback, link-local, or metadata address");
    }
  }

  return normalizedUrlString(parsed);
}

/**
 * The WHATWG URL serializer output as a freshly derived string. The component
 * encode/decode round trip is a byte-identical no-op on a normalized URL (the
 * URL parser already percent-encodes everything component encoding can reject),
 * but it hands callers a copy of the validated value rather than a string still
 * traceable to raw request input, so request-forgery analysis treats the result
 * as validated configuration instead of user-controlled data.
 */
function normalizedUrlString(parsed: URL): string {
  return decodeURIComponent(encodeURIComponent(parsed.toString()));
}

function ipv4ToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv4InRange(ipNum: number, network: string, prefix: number): boolean {
  const networkNum = ipv4ToNumber(network);
  const mask = prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1) >>> 0;
  return (ipNum & mask) === (networkNum & mask);
}

function isForbiddenIPv4(ip: string): boolean {
  const num = ipv4ToNumber(ip);
  const ranges: Array<[string, number]> = [
    ["0.0.0.0", 8], // "this" network
    ["10.0.0.0", 8], // private
    ["100.64.0.0", 10], // CGNAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local (incl. cloud metadata)
    ["172.16.0.0", 12], // private
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // TEST-NET-1
    ["192.168.0.0", 16], // private
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // TEST-NET-2
    ["203.0.113.0", 24], // TEST-NET-3
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved
  ];
  return ranges.some(([network, prefix]) => ipv4InRange(num, network, prefix));
}

function isForbiddenIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) — check the embedded IPv4.
  const mappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) {
    return isForbiddenIPv4(mappedMatch[1]);
  }
  // Normalize the common "::" forms for prefix matching.
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  )
    return true; // link-local fe80::/10
  if (
    lower.startsWith("fec") ||
    lower.startsWith("fed") ||
    lower.startsWith("fee") ||
    lower.startsWith("fef")
  )
    return true; // site-local fec0::/10
  if (lower.startsWith("ff")) return true; // multicast ff00::/8
  if (lower.startsWith("2001:db8")) return true; // documentation 2001:db8::/32
  return false;
}

function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isForbiddenIPv4(address);
  if (family === 6) return isForbiddenIPv6(address);
  // Unknown address family — treat as forbidden to be safe.
  return true;
}
