import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
import { Request, Response } from "express";

/**
 * Rate limiting middleware. Limits are configurable via environment variables
 * and emit a structured 429 (with a `Retry-After` header) on breach, matching
 * the `{ error, message }` shape used across the API.
 *
 *   RATE_LIMIT_WINDOW_MS        public window (default 60_000)
 *   RATE_LIMIT_MAX              public max requests per IP per window (default 100)
 *   RATE_LIMIT_ADMIN_WINDOW_MS  admin window  (default RATE_LIMIT_WINDOW_MS)
 *   RATE_LIMIT_ADMIN_MAX        admin max requests per IP per window (default 20)
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createRateLimiter(windowMs: number, max: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // RateLimit-* headers
    legacyHeaders: false, // disable X-RateLimit-* headers
    // express-rate-limit sets `Retry-After` automatically on the 429 response.
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: "too_many_requests",
        message: "Rate limit exceeded. Please retry later.",
      });
    },
  });
}

const PUBLIC_WINDOW_MS = intFromEnv("RATE_LIMIT_WINDOW_MS", 60_000);
const PUBLIC_MAX = intFromEnv("RATE_LIMIT_MAX", 100);
const ADMIN_WINDOW_MS = intFromEnv("RATE_LIMIT_ADMIN_WINDOW_MS", PUBLIC_WINDOW_MS);
const ADMIN_MAX = intFromEnv("RATE_LIMIT_ADMIN_MAX", 20);

/** Limiter for public, unauthenticated endpoints. */
export const publicLimiter = createRateLimiter(PUBLIC_WINDOW_MS, PUBLIC_MAX);

/** Stricter limiter for privileged admin endpoints. */
export const adminLimiter = createRateLimiter(ADMIN_WINDOW_MS, ADMIN_MAX);
