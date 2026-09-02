import { createHmac } from "crypto";
import { lookup } from "dns/promises";
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
