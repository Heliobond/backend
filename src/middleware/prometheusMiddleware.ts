import { Request, Response, NextFunction } from "express";
import { httpRequestDuration, httpRequestsTotal } from "../lib/prometheus";

function normalizeRoute(req: Request): string {
  if (req.route?.path) {
    return `${req.baseUrl}${req.route.path}`;
  }
  // req.route is only populated for matched routes. For unmatched requests
  // (404s, scanner/bot traffic, typos) we return a fixed placeholder so the
  // Prometheus `route` label cardinality stays bounded to the set of actual
  // registered route patterns rather than growing with every distinct URL a
  // scanner ever tries.
  return "unmatched";
}

export function prometheusMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpRequestDuration.startTimer();

  res.on("finish", () => {
    const route = normalizeRoute(req);
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    end(labels);
    httpRequestsTotal.inc(labels);
  });

  next();
}
