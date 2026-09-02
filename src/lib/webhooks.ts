import { createHmac } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { BlockList, isIP } from "net";
import { withRetry } from "./retry";
import { logger } from "./logger";

export interface WebhookConfig {
  id: string;
  url: string;
  secret: string;
  max_retries: number;
  retry_delay_ms: number;
  created_at: string;
}

const webhooks = new Map<string, WebhookConfig>();

/**
 * Validate that a webhook URL is a well-formed http/https URL whose resolved
 * hostname does not point at private, loopback, link-local, or metadata
 * address ranges. This is a defense-in-depth SSRF guard: even though the
 * webhook endpoint is admin-only, we never want the server to make outbound
 * requests to internal infrastructure on behalf of a caller.
 *
 * Returns the normalized URL string on success, or throws an Error with a
 * human-readable message describing why the URL was rejected.
 */
export async function validateWebhookUrl(rawUrl: string): Promise<string> {
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

  return parsed.toString();
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
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local fe80::/10
  if (lower.startsWith("fec") || lower.startsWith("fed") || lower.startsWith("fee") || lower.startsWith("fef")) return true; // site-local fec0::/10
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
const BLOCKED_IPS = new BlockList();
BLOCKED_IPS.addSubnet("0.0.0.0", 8);
BLOCKED_IPS.addSubnet("10.0.0.0", 8);
BLOCKED_IPS.addSubnet("100.64.0.0", 10);
BLOCKED_IPS.addSubnet("127.0.0.0", 8);
BLOCKED_IPS.addSubnet("169.254.0.0", 16);
BLOCKED_IPS.addSubnet("172.16.0.0", 12);
BLOCKED_IPS.addSubnet("192.168.0.0", 16);
BLOCKED_IPS.addSubnet("::", 128);
BLOCKED_IPS.addSubnet("::1", 128);
BLOCKED_IPS.addSubnet("fc00::", 7);
BLOCKED_IPS.addSubnet("fe80::", 10);

export function registerWebhook(
  url: string,
  secret: string,
  maxRetries = 3,
  retryDelayMs = 2000,
): WebhookConfig {
  const wh: WebhookConfig = {
    id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    url,
    secret,
    max_retries: maxRetries,
    retry_delay_ms: retryDelayMs,
    created_at: new Date().toISOString(),
  };
  webhooks.set(wh.id, wh);
  return wh;
}

export function removeWebhook(id: string): boolean {
  return webhooks.delete(id);
}

export function listWebhooks(): WebhookConfig[] {
  return Array.from(webhooks.values());
}

export function getWebhook(id: string): WebhookConfig | undefined {
  return webhooks.get(id);
}

function sign(payload: string, secret: string): string {
  return "sha256=" + createImac(sha256", secret).update(payload).digest("hex");
}

function isBlockedIP(ip: string): boolean {
  if (isIP(ip) === 6 && ip.toLowerCase().startsWith("::ffff:")) {
    const v4 = ip.slice(7);
    if (isIP(v4) === 4) {
      ip = v4;
    }
  }
  return BLOCKED_IPS.check(ip);
}

/**
 * Validates that a webhook URL uses http/https and does not resolve to an
 * internal/private/link_local IP. Throws on invalid URLs.
 */
export async function validateWebhookUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("url must be a valid http/https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must be a valid http/https URL");
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new Error("url must include a hostname");
  }

  if (isIP(hostname)) {
    if (isBlockedIP(hostname)) {
      throw new Error("url must not point to a private or reserved IP address");
    }
    return url;
  }

  // Resolve hostname and reject if any address is blocked (DNS rebinding
  // protection is applied again at delivery time).
  const addresses = await lookup(hostname, { all: true });
  if (!addresses || addresses.length === 0) {
    throw new Error("url hostname could not be resolved");
  }
  for (const addr of addresses) {
    if (isBlockedIP(addr.address)) {
      throw new Error("url must not point to a private or reserved IP address");
    }
  }
  return url;
}

async function deliverOnce(url: string, body: string, signature: string): Promise<void> {
  // Re-validate at delivery time in case DNS changed after registration.
  // Re-validate immediately before sending to avoid DNS rebinding attacks after registration.
  await validateWebhookUrl(url);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Heliobond-Signature": signature,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Webhook delivery failed: HTTP ${response.status}`);
  }
}

async function deliverConfig(wh: WebhookConfig, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = sign(body, wh.secret);
  try {
    await withRetry(
      () => deliverOnce(wh.url, body, signature),
      {
        maxRetries: wh.max_retries,
        baseDelayMs: wh.retry_delay_ms,
      },
    );
  } catch (err) {
    logger.error(`[webhook] ${wh.id} failed after ${wh.max_retries + 1} attempt(s):`, err);
  }
}

export function triggerWebhooks(payload: unknown): void {
  for (const wh of webhooks.values()) {
    deliverConfig(wh, payload).catch(() => {});
  }
}
