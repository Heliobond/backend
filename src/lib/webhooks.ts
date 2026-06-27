import { createHmac } from "crypto";

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

async function deliverWithRetry(wh: WebhookConfig, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = sign(body, wh.secret);
  for (let attempt = 0; attempt <= wh.max_retries; attempt++) {
    try {
      await deliverOnce(wh.url, body, signature);
      return;
    } catch (err) {
      if (attempt === wh.max_retries) {
        console.error(`[webhook] ${wh.id} failed after ${attempt + 1} attempt(s):`, err);
        return;
      }
      await new Promise((r) => setTimeout(r, wh.retry_delay_ms));
    }
  }
}

export function triggerWebhooks(payload: unknown): void {
  for (const wh of webhooks.values()) {
    deliverWithRetry(wh, payload).catch(() => {});
  }
}
