import { createHmac } from "crypto";
import { withRetry } from "./retry";
import { logger } from "./logger";
import { validatePublicUrl } from "./ssrf";
import { parseContractError, isRecord } from "./contractErrors";
import { config } from "../config";

/**
 * SSRF guard for webhook URLs — see {@link validatePublicUrl}.
 */
export const validateWebhookUrl = validatePublicUrl;

export interface WebhookConfig {
  id: string;
  url: string;
  secret: string;
  max_retries: number;
  retry_delay_ms: number;
  created_at: string;
  last_triggered_at?: string;
}

const webhooks = new Map<string, WebhookConfig>();
const WEBHOOK_CLEANUP_INTERVAL_MS = config.WEBHOOK_CLEANUP_INTERVAL_MS;
const WEBHOOK_STALE_THRESHOLD_MS = config.WEBHOOK_STALE_THRESHOLD_MS;

/**
 * Remove stale webhooks that haven't been triggered in a long time.
 * This prevents indefinite memory growth from abandoned webhook registrations.
 */
function cleanupStaleWebhooks(): void {
  const now = Date.now();
  for (const [id, webhook] of webhooks.entries()) {
    if (webhook.last_triggered_at) {
      const lastTriggered = new Date(webhook.last_triggered_at).getTime();
      if (now - lastTriggered > WEBHOOK_STALE_THRESHOLD_MS) {
        webhooks.delete(id);
        logger.info(
          `[webhooks] removed stale webhook ${id} (last triggered: ${webhook.last_triggered_at})`,
        );
      }
    }
  }
}

// Schedule periodic cleanup
let cleanupTimer: NodeJS.Timeout | null = null;
if (WEBHOOK_CLEANUP_INTERVAL_MS > 0) {
  cleanupTimer = setInterval(cleanupStaleWebhooks, WEBHOOK_CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }
}

export function stopWebhookCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

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

function enrichWebhookPayload(payload: unknown): unknown {
  if (isRecord(payload) && typeof payload.error === "string" && !payload.contract_error_name) {
    const decoded = parseContractError(payload.error);
    if (decoded) {
      return {
        ...payload,
        contract_error_name: decoded.name,
        contract_error_code: decoded.code,
      };
    }
  }
  return payload;
}

async function deliverConfig(wh: WebhookConfig, payload: unknown): Promise<void> {
  const body = JSON.stringify(enrichWebhookPayload(payload));
  const signature = sign(body, wh.secret);
  try {
    await withRetry(() => deliverOnce(wh.url, body, signature), {
      maxAttempts: wh.max_retries + 1,
      baseDelayMs: wh.retry_delay_ms,
    });

    // Update last triggered timestamp on successful delivery
    wh.last_triggered_at = new Date().toISOString();
  } catch (err) {
    logger.error(
      `[webhook] ${wh.id} failed after ${wh.max_retries + 1} attempt(s)`,
      logger.formatError(err),
    );
  }
}

export function triggerWebhooks(payload: unknown): void {
  for (const wh of webhooks.values()) {
    deliverConfig(wh, payload).catch(() => {});
  }
}
