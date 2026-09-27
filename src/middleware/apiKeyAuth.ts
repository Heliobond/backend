import { Request, Response, NextFunction } from "express";
import { resolveAuthContext, incrementUsage } from "../lib/apiKeys";
import { errorBody } from "./errors";

export interface AuthenticatedRequest extends Request {
  apiKeyInfo?: {
    id: string;
    consumer_name: string;
    rate_limit: number;
  };
}

/**
 * Authenticate a consumer request from either the `Authorization: Bearer` or
 * `X-API-Key` header.
 *
 * Header resolution, the `ADMIN_API_KEY` bypass and the rate-limit lookup all
 * live in `resolveAuthContext`, so this middleware only maps that context onto
 * a response instead of re-deriving the key itself (#640).
 */
export function apiKeyAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const auth = resolveAuthContext(req.headers);

  // The admin key bypasses consumer bookkeeping entirely.
  if (auth.isAdmin) {
    return next();
  }

  if (!auth.providedKey) {
    return res
      .status(401)
      .json(
        errorBody(
          "unauthorized",
          "Missing API key in Authorization bearer token or X-API-Key header",
        ),
      );
  }

  // `resolveAuthContext` only sets `rateLimited` for keys that actually exist,
  // so a revoked/unknown key still falls through to the 401 below.
  if (auth.rateLimited) {
    return res
      .status(429)
      .json(
        errorBody("too_many_requests", "Rate limit exceeded for this API key. Please retry later."),
      );
  }

  if (!auth.isConsumer || !auth.keyRecord) {
    return res.status(401).json(errorBody("unauthorized", "Invalid or revoked API key"));
  }

  // Increment usage
  incrementUsage(auth.keyRecord.id);

  // Attach metadata
  req.apiKeyInfo = {
    id: auth.keyRecord.id,
    consumer_name: auth.keyRecord.consumer_name,
    rate_limit: auth.keyRecord.rate_limit,
  };

  next();
}
