import { Request, Response, NextFunction } from "express";
import { legacyApiRequestsTotal } from "../lib/prometheus";
import { logger } from "../lib/logger";

const CURRENT_VERSION = "1";
const SUPPORTED_VERSIONS = ["1"];

export function versionHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("API-Version", CURRENT_VERSION);
  res.setHeader("API-Supported-Versions", SUPPORTED_VERSIONS.join(", "));
  next();
}

export function acceptVersion(req: Request, res: Response, next: NextFunction): void {
  const requested = req.headers["accept-version"] as string | undefined;
  if (requested && !SUPPORTED_VERSIONS.includes(requested)) {
    res.status(400).json({
      error: "Unsupported API version",
      requested,
      supported: SUPPORTED_VERSIONS,
    });
    return;
  }
  next();
}

export const LEGACY_SUNSET_DATE = new Date("2027-01-01T00:00:00Z");

export function deprecationHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "2027-01-01T00:00:00Z");
  res.setHeader(
    "Link",
    '</v1>; rel="successor-version"'
  );
  next();
}

/**
 * Collapse a legacy path to a low-cardinality metric label: first two segments,
 * numeric/uuid-ish ids replaced with ":id" (e.g. /api/projects/42/history -> /api/projects).
 */
export function legacyPathLabel(originalUrl: string): string {
  const path = originalUrl.split("?")[0];
  return (
    path
      .split("/")
      .filter(Boolean)
      .slice(0, 2)
      .map((seg) => (/^\d+$/.test(seg) ? ":id" : seg))
      .join("/")
      .replace(/^/, "/") || "/"
  );
}

/**
 * Mounted on /api. Counts and logs every legacy request; once the Sunset date
 * has passed it answers 410 Gone pointing at /v1 instead of serving the route.
 * `now` is injectable for tests.
 */
export function legacyApiUsage(now: () => number = Date.now) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = legacyPathLabel(req.originalUrl);
    legacyApiRequestsTotal.inc({ path });
    logger.warn(`[legacy-api] ${req.method} ${req.originalUrl}`);

    if (now() >= LEGACY_SUNSET_DATE.getTime()) {
      const successor = req.originalUrl.replace(/^\/api(?=\/|$|\?)/, "/v1");
      res.setHeader("Link", `<${successor}>; rel="successor-version"`);
      res.status(410).json({
        error: {
          code: "gone",
          message: "The unversioned /api/* routes were removed on 2027-01-01. Use /v1 instead.",
          successor,
        },
      });
      return;
    }
    next();
  };
}
