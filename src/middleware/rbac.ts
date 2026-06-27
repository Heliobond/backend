import { Request, Response, NextFunction } from "express";
import type { Role } from "../lib/roles";
import { hasPermission } from "../lib/roles";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * Resolve the caller's user identity from the X-User-Id header.
 * This is intentionally thin — in production you'd verify a JWT here.
 */
export function identifyUser(req: Request, res: Response, next: NextFunction): void {
  const userId = req.headers["x-user-id"];
  if (typeof userId === "string" && userId.trim()) {
    req.userId = userId.trim();
  }
  next();
}

/** Reject the request with 401 when no user identity is present. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId) {
    res.status(401).json({ error: "unauthorized", message: "X-User-Id header is required" });
    return;
  }
  next();
}

/** Reject the request with 403 when the caller lacks the required role. */
export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.userId || !hasPermission(req.userId, role)) {
      res.status(403).json({
        error: "forbidden",
        message: `This action requires the '${role}' role or higher`,
      });
      return;
    }
    next();
  };
}
