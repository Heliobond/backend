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

export function apiKeyAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const auth = resolveAuthContext(req.headers);

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
