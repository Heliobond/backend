import { Request, Response, NextFunction } from "express";
import { timingSafeCompare } from "../lib/timing-safe";
import { logger } from "../lib/logger";

/**
 * Shared middleware that enforces the ADMIN_API_KEY bearer token using a
 * constant-time comparison so the check is not vulnerable to timing attacks.
 *
 * Behaviour:
 *  - If ADMIN_API_KEY is not set, the server fails closed in every environment
 *    (including staging) with a 500 `server_misconfigured`.
 *  - If the Authorization header does not exactly match `Bearer <ADMIN_API_KEY>`,
 *    a 401 is returned immediately.
 *
 * Use this instead of inline `req.headers.authorization === \`Bearer ${apiKey}\``
 * checks — those short-circuit on the first differing byte and can leak the
 * secret one character at a time under a timing oracle.
 */
export function requireAdminBearer(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.ADMIN_API_KEY;
  if (!apiKey) {
    logger.error("ADMIN_API_KEY is not set; rejecting admin request", {
      code: "server_misconfigured",
      path: req.path,
    });
    res.status(500).json({ error: "server_misconfigured", message: "ADMIN_API_KEY is not set" });
    return;
  }

  const provided = req.headers.authorization ?? "";
  if (!timingSafeCompare(provided, `Bearer ${apiKey}`)) {
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid bearer token" });
    return;
  }

  next();
}
