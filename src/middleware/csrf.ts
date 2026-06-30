import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

const CSRF_TOKEN_LENGTH = 32;
const CSRF_TOKEN_EXPIRY_MS = 60 * 60 * 1000;

interface CsrfTokenEntry {
  token: string;
  createdAt: number;
}

const tokenStore = new Map<string, CsrfTokenEntry>();

function generateToken(): string {
  return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString("hex");
}

function cleanExpiredTokens(): void {
  const now = Date.now();
  for (const [key, entry] of tokenStore) {
    if (now - entry.createdAt > CSRF_TOKEN_EXPIRY_MS) {
      tokenStore.delete(key);
    }
  }
}

function getClientIdentifier(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";
  return `${ip}:${userAgent}`;
}

export function generateCsrfToken(req: Request, res: Response): string {
  cleanExpiredTokens();
  const identifier = getClientIdentifier(req);
  const existing = tokenStore.get(identifier);
  if (existing && Date.now() - existing.createdAt < CSRF_TOKEN_EXPIRY_MS) {
    return existing.token;
  }
  const token = generateToken();
  tokenStore.set(identifier, { token, createdAt: Date.now() });
  return token;
}

export function setCsrfCookie(req: Request, res: Response): void {
  const token = generateCsrfToken(req, res);
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie("XSRF-TOKEN", token, {
    httpOnly: false,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
    path: "/",
  });
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    setCsrfCookie(req, res);
    return next();
  }

  const headerToken =
    req.headers["x-csrf-token"] as string | undefined ||
    req.headers["x-xsrf-token"] as string | undefined;
  const cookieToken = req.cookies?.["XSRF-TOKEN"];
  const bodyToken = (req.body as Record<string, unknown>)?._csrf as string | undefined;

  const token = headerToken || bodyToken;
  if (!token) {
    res.status(403).json({
      error: "csrf_token_missing",
      message: "CSRF token is required for this request",
    });
    return;
  }

  const identifier = getClientIdentifier(req);
  const stored = tokenStore.get(identifier);
  if (!stored || stored.token !== token) {
    res.status(403).json({
      error: "csrf_token_invalid",
      message: "CSRF token is invalid or expired",
    });
    return;
  }

  if (Date.now() - stored.createdAt > CSRF_TOKEN_EXPIRY_MS) {
    tokenStore.delete(identifier);
    res.status(403).json({
      error: "csrf_token_expired",
      message: "CSRF token has expired",
    });
    return;
  }

  const origin = req.headers.origin || req.headers.referer;
  const allowedOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (origin && allowedOrigins.length > 0) {
    const originUrl = new URL(origin);
    const isAllowed = allowedOrigins.some((allowed) => {
      try {
        const allowedUrl = new URL(allowed);
        return originUrl.hostname === allowedUrl.hostname;
      } catch {
        return origin === allowed;
      }
    });
    if (!isAllowed) {
      res.status(403).json({
        error: "csrf_origin_invalid",
        message: "Request origin is not allowed",
      });
      return;
    }
  }

  next();
}

export function resetCsrfStore(): void {
  tokenStore.clear();
}
