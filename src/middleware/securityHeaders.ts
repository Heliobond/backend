import helmet from "helmet";
import { RequestHandler } from "express";

/**
 * Composed helmet middleware that sets the following security headers:
 *   Content-Security-Policy  — restricts resource origins
 *   X-Frame-Options          — blocks clickjacking (SAMEORIGIN)
 *   X-Content-Type-Options   — prevents MIME sniffing
 *   Strict-Transport-Security — enforces HTTPS for 1 year
 *   X-XSS-Protection         — legacy browser XSS filter
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
    maxAge: 31_536_000, // 1 year in seconds
    includeSubDomains: true,
    preload: true,
  },
  xssFilter: true,
});
