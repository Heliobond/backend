import { getCorrelationId } from "./correlation";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
  return raw in LEVEL_RANK ? raw : "info";
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[configuredLevel()];
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!shouldEmit(level)) return;
  const entry: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    correlation_id: getCorrelationId(),
    message,
    ...meta,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
};
