import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
  return raw in LEVEL_RANK ? raw : "info";
}

function shouldLog(status: number): boolean {
  const level = configuredLevel();
  if (level === "debug" || level === "info") return true;
  if (level === "warn") return status >= 400;
  return status >= 500;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const correlationId = (req.headers["x-correlation-id"] as string) || randomUUID();
  req.headers["x-correlation-id"] = correlationId;
  res.setHeader("X-Correlation-Id", correlationId);

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    if (!shouldLog(res.statusCode)) return;
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    const line: Record<string, unknown> = {
      level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      time: new Date().toISOString(),
      correlation_id: correlationId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      latency_ms: Math.round(latencyMs * 1000) / 1000,
    };
    if (configuredLevel() === "debug") {
      line.content_length = res.getHeader("content-length") ?? null;
    }
    console.log(JSON.stringify(line));
  });

  next();
}
