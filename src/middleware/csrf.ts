import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

const CSRF_TOKEN_LENGTH = 32;
const CSRF_TOKEN_EXPIRY_MS = 60 * 60 * 1000;
const SYSSESION_COOKIE_NAME = "CSRF-SESSION";

interface CsrfTokenEntry {
  token: string;
  createdAt: number;
}

const tokenStore = new Map<string, CsrfTokenEntry>();

function generateToken(): string {
  return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString("hex");
}

function generateSessionId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function cleanExpiredTokens(): void {
  const now = Date.now();
  for (const [key, entry] of tokenStore) {
    if (now - entry.createdAt > CSRF_TOKEN_EXPIRY_MS) {
      tokenStore.delete(key);
    }
  }
}

function getCookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
  };
}

function getSessionId(req: Request): string | undefined {
  return req.cookies?[SESSION_COOKIE_NAME] as string | undefined;
}

export function generateCsrfToken(req: Request, res: Response): string {
  cleanExpiredTokens();

  let sessionId = getSessionId(req);
  if (!sessionId) {
    sessionId = generateSessionId();
    const opts = getCookieOptions();
    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      ...opts,
      httpOnly: true,
      path: "/",
    });
  }

  const existing = tokenStore.get(sessionId);
  if (existing && Date.now() - existing.createdAt < CSRF_TOKEN_EXPIRY_MS) {
    return existing.token;
  }

  const token = generateToken();
  tokenStore.set(sessionId, { token, createdAt: Date.now() });
  return token;
}

export function setCsrfCookie(req: Request, res: Response): void {
  const token = generateCsrfToken(req, res);
  const opts = getCookieOptions();
  res.cookie("XSRF-TOKEN", token, {
    ...opts,
    httpOnly: false,
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
  const cookieToken = req.cookies?["XSRF-TOKEN"] as string | undefined;
  const bodyToken = (req.body as Record<string, unknown>)?._csrf as string | undefined;

  const token = headerToken || bodyToken;
  if (!token) {
    res.status(403).json({
      error: "csrf_token_missing",
      message: "CSRF Token is required for this request",
    });
    return;
  }

  if (!cookieToken || !timingSafeCompare(token, cookieToken)) {
    res.status(403).json({
      error: "csrf_token_invalid",
      message: "CSRF token does not match the cookie token",
    });
    return;
  }

  const sessionId = getSessionId(req);
  if (!sessionId) {
    res.status(403).json({
      error: "csrf_token_invalid",
      message: "CSRF session is missing",
    });
    return;
  }

  const stored = tokenStore.get(sessionId);
  if (!stored || !timingSafeCompare(stored.token, token)) {
    res.status(403).json({
      error: "csrf_token_invalid",
      message: "CSRF token is invalid or expired",
    });
    return;
  }

  if (Date.now() - stored.createdAt > CSRF_TOKEN_EXPIRY_MS) {
    tokenStore.delete(sessionId);
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
