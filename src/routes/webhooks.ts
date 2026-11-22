import { Router, Request, Response, NextFunction } from "express";
import {
  registerWebhook,
  removeWebhook,
  listWebhooks,
  getWebhook,
  validateWebhookUrl,
} from "../lib/webhooks";
import { badRequest, errorBody } from "../middleware/errors";

const router = Router();

function getOwner(req: Request): string | undefined {
  return (
    (req.headers["x-consumer-name"] as string) ||
    (req.headers["x-consumer-id"] as string) ||
    (req as any).apiKey?.consumer_name ||
    undefined
  );
}

/**
 * POST /api/webhooks
 * Body: { url, secret, max_retries?, retry_delay_ms? }
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

    if (max_retries !== undefined) {
      if (
        typeof max_retries !== "number" ||
        !Number.isInteger(max_retries) ||
        max_retries < 0 ||
        max_retries > 10
      ) {
        throw badRequest("max_retries must be an integer between 0 and 10");
      }
    }
    if (retry_delay_ms !== undefined) {
      if (
        typeof retry_delay_ms !== "number" ||
        !Number.isInteger(retry_delay_ms) ||
        retry_delay_ms < 0 ||
        retry_delay_ms > 60000
      ) {
        throw badRequest("retry_delay_ms must be an integer between 0 and 60000");
      }
    }

    const maxRetries =
      typeof max_retries === "number" && max_retries >= 0 ? Math.floor(max_retries) : 3;
    const retryDelay =
      typeof retry_delay_ms === "number" && retry_delay_ms >= 0 ? Math.floor(retry_delay_ms) : 2000;

    const owner = getOwner(req);
    const wh = registerWebhook(validatedUrl, secret, maxRetries, retryDelay, owner);
    res.status(201).json({
      id: wh.id,
      url: wh.url,
      max_retries: wh.max_retries,
      retry_delay_ms: wh.retry_delay_ms,
      created_at: wh.created_at,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", (req: Request, res: Response) => {
  const owner = getOwner(req);
  const list = listWebhooks(owner).map(({ id, url, max_retries, retry_delay_ms, created_at }) => ({
    id,
    url,
    max_retries,
    retry_delay_ms,
    created_at,
  }));
  res.json({ webhooks: list });
});

router.get("/:id", (req: Request, res: Response) => {
  const owner = getOwner(req);
  const wh = getWebhook(String(req.params["id"]));
  if (!wh || (owner && wh.owner && wh.owner !== owner)) {
    res.status(404).json(errorBody("not_found", "Webhook not found"));
    return;
  }
  res.json({
    id: wh.id,
    url: wh.url,
    max_retries: wh.max_retries,
    retry_delay_ms: wh.retry_delay_ms,
    created_at: wh.created_at,
  });
});

router.delete("/:id", (req: Request, res: Response) => {
  const owner = getOwner(req);
  const id = String(req.params["id"]);
  const wh = getWebhook(id);
  if (!wh || (owner && wh.owner && wh.owner !== owner)) {
    res.status(404).json(errorBody("not_found", "Webhook not found"));
    return;
  }
  const removed = removeWebhook(id);
  if (!removed) {
    res.status(404).json(errorBody("not_found", "Webhook not found"));
    return;
  }
  res.json({ removed: true });
});

export default router;
