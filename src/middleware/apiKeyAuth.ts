import { Request, Response, NextFunction } from "express";
import { resolveAuthFromHeaders } from "../lib/authHelper";

export interface AuthenticatedRequest extends Request {
  apiKeyInfo?: {
    id: string;
    consumer_name: string;
    rate_limit: number;
  };
}

export function apiKeyAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const auth = resolveAuthFromHeaders(req.headers as any);

  if (auth.isAdmin) {
    return next();
  }

  if (auth.error === "missing") {
    return res.status(401).json({
      error: "unauthorized",
      message: "Missing API key in Authorization bearer token or X-API-Key header",
    });
  }

  if (auth.error === "invalid") {
    return res.status(401).json({
      error: "unauthorized",
      message: "Invalid or revoked API key",
    });
  }

  if (auth.error === "rate_limited") {
    return res.status(429).json({
      error: "too_many_requests",
      message: "Rate limit exceeded for this API key. Please retry later.",
    });
  }

  if (auth.isConsumer && auth.apiKeyId && auth.consumerName && auth.rateLimit !== undefined) {
    req.apiKeyInfo = {
      id: auth.apiKeyId,
      consumer_name: auth.consumerName,
      rate_limit: auth.rateLimit,
    };
  }

  next();
}
