import { Router, Request, Response } from "express";
import {
  registerWebhook,
  removeWebhook,
  listWebhooks,
  getWebhook,
} from "../lib/webhooks";
import { badRequest } from "../middleware/errors";

const router = Router();

/**
 * POST /api/webhooks
 * Body: { url, secret, max_retries?, retry_delay_ms? }
 * Registers a new webhook endpoint.
 */
router.post("/", (req: Request, res: Response) => {
  const { url, secret, max_retries, retry_delay_ms } = req.body as {
    url?: unknown;
    secret?: unknown;
    max_retries?: unknown;
    retry_delay_ms?: unknown;
  };

  if (typeof url !== "string" || !url.startsWith("http")) {
    throw badRequest("url must be a valid http/https URL");
  }
  if (typeof secret !== "string" || secret.length < 16) {
    throw badRequest("secret must be a string of at least 16 characters");
  }

  const maxRetries =
    typeof max_retries === "number" && max_retries >= 0 ? Math.floor(max_retries) : 3;
  const retryDelay =
    typeof retry_delay_ms === "number" && retry_delay_ms >= 0
      ? Math.floor(retry_delay_ms)
      : 2000;

  const wh = registerWebhook(url, secret, maxRetries, retryDelay);
  res.status(201).json({
    id: wh.id,
    url: wh.url,
    max_retries: wh.max_retries,
    retry_delay_ms: wh.retry_delay_ms,
    created_at: wh.created_at,
  });
});

/** GET /api/webhooks — list all registered webhooks (secrets omitted) */
router.get("/", (_req: Request, res: Response) => {
  const list = listWebhooks().map(({ id, url, max_retries, retry_delay_ms, created_at }) => ({
    id,
    url,
    max_retries,
    retry_delay_ms,
    created_at,
  }));
  res.json({ webhooks: list });
});

/** GET /api/webhooks/:id — fetch one webhook (secret omitted) */
router.get("/:id", (req: Request, res: Response) => {
  const wh = getWebhook(req.params["id"]);
  if (!wh) {
    res.status(404).json({ error: "not_found", message: "Webhook not found" });
    return;
  }
  res.json({ id: wh.id, url: wh.url, max_retries: wh.max_retries, retry_delay_ms: wh.retry_delay_ms, created_at: wh.created_at });
});

/** DELETE /api/webhooks/:id — unregister a webhook */
router.delete("/:id", (req: Request, res: Response) => {
  const removed = removeWebhook(req.params["id"]);
  if (!removed) {
    res.status(404).json({ error: "not_found", message: "Webhook not found" });
    return;
  }
  res.json({ removed: true });
});

export default router;
