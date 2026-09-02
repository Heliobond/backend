import { createHmac } from "crypto";
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
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

async function deliverOnce(url: string, body: string, signature: string): Promise<void> {
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
