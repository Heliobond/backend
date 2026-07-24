import { Router, Request, Response, NextFunction } from "express";
import {
  generateApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  getApiKeyDetails,
  checkScheduledRotations,
  getRotationStatus,
  onRotation,
} from "../lib/apiKeys";
import { badRequest } from "../middleware/errors";
import { logger } from "../lib/logger";

const router = Router();

// Enforce ADMIN_API_KEY if configured
router.use((req: Request, res: Response, next: NextFunction) => {
  const apiKey = process.env.ADMIN_API_KEY;
  if (!apiKey) return next();
  if (req.headers.authorization !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: "unauthorized", message: "Missing or invalid bearer token" });
  }
  next();
});

// Register rotation notification logging
onRotation((notification) => {
  logger.info("API key rotated", {
    key_id: notification.key_id,
    consumer_name: notification.consumer_name,
    old_key_expires_at: new Date(notification.old_key_expires_at).toISOString(),
  });
});

// POST / — Generate a new API key
router.post("/", (req: Request, res: Response, next: NextFunction) => {
  try {
    const { consumer_name, rate_limit, rotation_interval_days } = req.body;
    if (!consumer_name || typeof consumer_name !== "string") {
      throw badRequest("consumer_name is required and must be a string");
    }

    let parsedRateLimit: number | undefined;
    if (rate_limit !== undefined) {
      parsedRateLimit = Number(rate_limit);
      if (!Number.isInteger(parsedRateLimit) || parsedRateLimit <= 0) {
        throw badRequest("rate_limit must be a positive integer");
      }
    }

    let parsedRotationInterval: number | undefined;
    if (rotation_interval_days !== undefined) {
      parsedRotationInterval = Number(rotation_interval_days);
      if (!Number.isInteger(parsedRotationInterval) || parsedRotationInterval <= 0) {
        throw badRequest("rotation_interval_days must be a positive integer");
      }
    }

    const keyInfo = generateApiKey(consumer_name, parsedRateLimit, parsedRotationInterval);
    res.status(201).json(keyInfo);
  } catch (error) {
    next(error);
  }
});

// GET / — List all API keys
router.get("/", (_req: Request, res: Response, next: NextFunction) => {
  try {
    const keys = listApiKeys();
    res.json({ count: keys.length, keys });
  } catch (error) {
    next(error);
  }
});

// GET /rotation/status — Get rotation status for all keys
router.get("/rotation/status", (_req: Request, res: Response, next: NextFunction) => {
  try {
    const status = getRotationStatus();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

// POST /rotation/trigger — Manually trigger scheduled rotations
router.post("/rotation/trigger", (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rotated = checkScheduledRotations();
    res.json({
      rotated: rotated.length,
      keys: rotated.map((k) => ({
        id: k.id,
        consumer_name: k.consumer_name,
        next_rotation_at: k.next_rotation_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// POST /:id/rotate — Rotate an API key
router.post("/:id/rotate", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const body = req.body || {};
    const grace_period_ms = body.grace_period_ms
      ? Number(body.grace_period_ms)
      : undefined;

    if (grace_period_ms !== undefined && (grace_period_ms < 0 || !Number.isFinite(grace_period_ms))) {
      throw badRequest("grace_period_ms must be a non-negative number");
    }

    const rotated = rotateApiKey(id, grace_period_ms);
    if (!rotated) {
      return res.status(404).json({ error: "not_found", message: "Active API key not found" });
    }
    res.json(rotated);
  } catch (error) {
    next(error);
  }
});

// DELETE /:id — Revoke an API key
router.delete("/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const revoked = revokeApiKey(id);
    if (!revoked) {
      return res.status(404).json({ error: "not_found", message: "API key not found" });
    }
    res.json({ success: true, message: "API key revoked successfully" });
  } catch (error) {
    next(error);
  }
});

// GET /:id/usage — Get usage tracking statistics
router.get("/:id/usage", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const keyDetails = getApiKeyDetails(id);
    if (!keyDetails) {
      return res.status(404).json({ error: "not_found", message: "API key not found" });
    }
    res.json({
      id: keyDetails.id,
      consumer_name: keyDetails.consumer_name,
      usage_count: keyDetails.usage_count,
      last_used_at: keyDetails.last_used_at,
      rate_limit: keyDetails.rate_limit,
      rotation_interval_days: keyDetails.rotation_interval_days,
      next_rotation_at: keyDetails.next_rotation_at,
      last_rotated_at: keyDetails.last_rotated_at,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
