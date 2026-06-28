import { Router, Request, Response, NextFunction } from "express";
import {
  generateApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  getApiKeyDetails,
} from "../lib/apiKeys";
import { badRequest } from "../middleware/errors";

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

// POST / — Generate a new API key
router.post("/", (req: Request, res: Response, next: NextFunction) => {
  try {
    const { consumer_name, rate_limit } = req.body;
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

    const keyInfo = generateApiKey(consumer_name, parsedRateLimit);
    res.status(201).json(keyInfo); // Returning 201 Created or custom success
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

// POST /:id/rotate — Rotate an API key
router.post("/:id/rotate", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const rotated = rotateApiKey(id);
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
    });
  } catch (error) {
    next(error);
  }
});

export default router;
