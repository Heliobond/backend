import { Request, Response, NextFunction } from "express";

/**
 * Structured request logging. Emits one JSON line per request once the response
 * has been sent, including method, path, status, and latency in milliseconds.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    const line = {
      level: "info",
      time: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      latency_ms: Math.round(latencyMs * 1000) / 1000,
    };
    console.log(JSON.stringify(line));
  });

  next();
}
