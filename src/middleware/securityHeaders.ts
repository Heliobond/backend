import helmet from "helmet";
import { RequestHandler } from "express";

/**
 * Composed helmet middleware that sets the following security headers:
 *   Content-Security-Policy  — restricts resource origins
 *   X-Frame-Options          — blocks clickjacking (SAMEORIGIN)
 *   X-Content-Type-Options   — prevents MIME sniffing
 *   Strict-Transport-Security — enforces HTTPS for 1 year
 *   X-XSS-Protection         — legacy browser XSS filter
 *   Referrer-Policy          — controls referrer information leakage
 *   Permissions-Policy       — restricts browser feature access
 */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  frameguard: { action: "sameorigin" },
  noSniff: true,
  hsts: {
    maxAge: 31_536_000,
    includeSubDomains: true,
    preload: true,
  },
  xssFilter: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
});

export const permissionsHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
  );
  next();
};
