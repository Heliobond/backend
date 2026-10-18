import { Router, Request, Response, NextFunction } from "express";
import {
  registerWebhook,
  removeWebhook,
  listWebhooks,
  getWebhook,
  validateWebhookUrl,
} from "../lib/webhooks";
import { badRequest } from "../middleware/errors";

export const MAX_ALLOWED_RETRIES = 10;
export const MIN_ALLOWED_RETRY_DELAY_MS = 100;
export const MAX_ALLOWED_RETRY_DELAY_MS = 60000;

export function extractWebhookOwner(req: Request): string {
  const headerConsumer =
    (req.headers["x-consumer-name"] as string | undefined) ||
    (req.headers["x-consumer-id"] as string | undefined) ||
    (req.headers["x-tenant-id"] as string | undefined);
  if (headerConsumer && typeof headerConsumer === "string" && headerConsumer.trim()) {
    return headerConsumer.trim();
  }
  const bodyOwner = (req.body as Record<string, unknown> | undefined)?.owner;
  if (typeof bodyOwner === "string" && bodyOwner.trim()) {
    return bodyOwner.trim();
  }
  const queryOwner = req.query?.owner;
  if (typeof queryOwner === "string" && queryOwner.trim()) {
    return queryOwner.trim();
  }
  return "default";
}

const router = Router();

/**
 * POST /api/webhooks
 * Body: { url, secret, max_retries?, retry_delay_ms?, owner? }
 * Registers a new webhook endpoint.
 */
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, secret, max_retries, retry_delay_ms } = req.body as {
      url?: unknown;
      secret?: unknown;
      max_retries?: unknown;
      retry_delay_ms?: unknown;
    };

    if (typeof url !== "string") {
      throw badRequest("url must be a valid http/https URL");
    }
    if (typeof secret !== "string" || secret.length < 16) {
      throw badRequest("secret must be a string of at least 16 characters");
    }

    let validatedUrl: string;
    try {
      validatedUrl = await validateWebhookUrl(url);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "url must be a valid http/https URL");
    }

    let maxRetries = 3;
    if (max_retries !== undefined) {
      if (
        typeof max_retries !== "number" ||
        !Number.isFinite(max_retries) ||
        Math.floor(max_retries) !== max_retries ||
        max_retries < 0 ||
        max_retries > MAX_ALLOWED_RETRIES
      ) {
        throw badRequest(`max_retries must be an integer between 0 and ${MAX_ALLOWED_RETRIES}`);
      }
      maxRetries = max_retries;
    }

    let retryDelay = 2000;
    if (retry_delay_ms !== undefined) {
      if (
        typeof retry_delay_ms !== "number" ||
        !Number.isFinite(retry_delay_ms) ||
        Math.floor(retry_delay_ms) !== retry_delay_ms ||
        retry_delay_ms < MIN_ALLOWED_RETRY_DELAY_MS ||
        retry_delay_ms > MAX_ALLOWED_RETRY_DELAY_MS
      ) {
        throw badRequest(
          `retry_delay_ms must be an integer between ${MIN_ALLOWED_RETRY_DELAY_MS} and ${MAX_ALLOWED_RETRY_DELAY_MS}`,
        );
      }
      retryDelay = retry_delay_ms;
    }

    const owner = extractWebhookOwner(req);
    const wh = registerWebhook(validatedUrl, secret, maxRetries, retryDelay, owner);
    res.status(201).json({
      id: wh.id,
      url: wh.url,
      max_retries: wh.max_retries,
      retry_delay_ms: wh.retry_delay_ms,
      owner: wh.owner,
      created_at: wh.created_at,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", (req: Request, res: Response) => {
  const owner = extractWebhookOwner(req);
  const list = listWebhooks(owner).map(
    ({ id, url, max_retries, retry_delay_ms, owner, created_at }) => ({
      id,
      url,
      max_retries,
      retry_delay_ms,
      owner,
      created_at,
    }),
  );
  res.json({ webhooks: list });
});

router.get("/:id", (req: Request, res: Response) => {
  const owner = extractWebhookOwner(req);
  const wh = getWebhook(String(req.params["id"]), owner);
  if (!wh) {
    res.status(404).json({ error: "not_found", message: "Webhook not found" });
    return;
  }
  res.json({
    id: wh.id,
    url: wh.url,
    max_retries: wh.max_retries,
    retry_delay_ms: wh.retry_delay_ms,
    owner: wh.owner,
    created_at: wh.created_at,
  });
});

router.delete("/:id", (req: Request, res: Response) => {
  const owner = extractWebhookOwner(req);
  const removed = removeWebhook(String(req.params["id"]), owner);
  if (!removed) {
    res.status(404).json({ error: "not_found", message: "Webhook not found" });
    return;
  }
  res.json({ removed: true });
});

export default router;
