import { Request, Response, NextFunction } from "express";
import { validateApiKey, incrementUsage, isRateLimited } from "../lib/apiKeys";
import { timingSafeCompare } from "../lib/timing-safe";
import { errorBody } from "./errors";

export interface AuthenticatedRequest extends Request {
  apiKeyInfo?: {
    id: string;
    consumer_name: string;
    rate_limit: number;
  };
}

export function apiKeyAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers["x-api-key"];
  let providedKey = "";

  if (apiKeyHeader && typeof apiKeyHeader === "string") {
    providedKey = apiKeyHeader;
  } else if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.substring(7);
  }

  // Fallback / support for existing ADMIN_API_KEY (constant-time comparison)
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && timingSafeCompare(providedKey, adminKey)) {
    return next();
  }

  if (!providedKey) {
    return res
      .status(401)
      .json(
        errorBody(
          "unauthorized",
          "Missing API key in Authorization bearer token or X-API-Key header",
        ),
      );
  }

  const apiKeyRecord = validateApiKey(providedKey);
  if (!apiKeyRecord) {
    return res.status(401).json(errorBody("unauthorized", "Invalid or revoked API key"));
  }

  // Enforce rate limit
  if (isRateLimited(apiKeyRecord.id, apiKeyRecord.rate_limit)) {
    return res
      .status(429)
      .json(
        errorBody("too_many_requests", "Rate limit exceeded for this API key. Please retry later."),
      );
  }

  // Increment usage
  incrementUsage(apiKeyRecord.id);

  // Attach metadata
  req.apiKeyInfo = {
    id: apiKeyRecord.id,
    consumer_name: apiKeyRecord.consumer_name,
    rate_limit: apiKeyRecord.rate_limit,
  };

  next();
}
