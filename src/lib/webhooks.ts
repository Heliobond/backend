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
  owner?: string;
  last_triggered_at?: string;
  consecutive_failures?: number;
}

const webhooks = new Map<string, WebhookConfig>();
const WEBHOOK_CLEANUP_INTERVAL_MS = config.WEBHOOK_CLEANUP_INTERVAL_MS;
const WEBHOOK_STALE_THRESHOLD_MS = config.WEBHOOK_STALE_THRESHOLD_MS;

/** Drop a webhook after this many consecutive failed delivery attempts. */
export const WEBHOOK_MAX_CONSECUTIVE_FAILURES = 10;

/** Hard cap on registered webhooks. The oldest registration is evicted first. */
export const WEBHOOK_MAX_STORE_SIZE = 1000;

/**
 * Remove stale webhooks. Age is measured from the last successful delivery,
 * falling back to the registration time for webhooks that never delivered,
 * so a dead endpoint cannot hold a slot forever. A webhook that delivered
 * before and then went quiet is only removed with a warning that names its
 * owner, so the deletion leaves a trace.
 */
export function cleanupStaleWebhooks(): void {
  const now = Date.now();
  for (const [id, webhook] of webhooks.entries()) {
    if ((webhook.consecutive_failures ?? 0) >= WEBHOOK_MAX_CONSECUTIVE_FAILURES) {
      webhooks.delete(id);
      logger.warn(
        `[webhooks] removed webhook ${id} after ${webhook.consecutive_failures} consecutive failed deliveries${webhook.owner ? ` (owner: ${webhook.owner})` : ""}`,
      );
      continue;
    }
    const lastActivity = webhook.last_triggered_at ?? webhook.created_at;
    const lastActivityMs = new Date(lastActivity).getTime();
    if (now - lastActivityMs > WEBHOOK_STALE_THRESHOLD_MS) {
      webhooks.delete(id);
      if (webhook.last_triggered_at) {
        logger.warn(
          `[webhooks] removed stale webhook ${id} (last triggered: ${webhook.last_triggered_at}${
            webhook.owner ? `, owner: ${webhook.owner}` : ""
          })`,
        );
      } else {
        logger.info(
          `[webhooks] removed webhook ${id} that never delivered (created: ${webhook.created_at})`,
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
  owner?: string,
): WebhookConfig {
  const wh: WebhookConfig = {
    id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    url,
    secret,
    max_retries: maxRetries,
    retry_delay_ms: retryDelayMs,
    created_at: new Date().toISOString(),
    owner,
    consecutive_failures: 0,
  };
  if (webhooks.size >= WEBHOOK_MAX_STORE_SIZE) {
    const oldest = webhooks.keys().next().value;
    if (oldest) {
      const owner = webhooks.get(oldest)?.owner;
      webhooks.delete(oldest);
      logger.warn(
        `[webhooks] store at capacity, evicted oldest webhook ${oldest}${owner ? ` (owner: ${owner})` : ""}`,
      );
    }
  }
  webhooks.set(wh.id, wh);
  return wh;
}

export function removeWebhook(id: string): boolean {
  return webhooks.delete(id);
}

export function listWebhooks(owner?: string): WebhookConfig[] {
  const all = Array.from(webhooks.values());
  if (!owner) return all;
  return all.filter((w) => !w.owner || w.owner === owner);
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
    wh.consecutive_failures = 0;
  } catch (err) {
    wh.consecutive_failures = (wh.consecutive_failures ?? 0) + 1;
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
