import { Request, Response, NextFunction } from "express";

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

export function deprecationHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "2027-01-01T00:00:00Z");
  res.setHeader(
    "Link",
    '</v1>; rel="successor-version"'
  );
  next();
}
