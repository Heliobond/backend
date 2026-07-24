import { getCorrelationId } from "./correlation";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const ENV_LEVEL_MAP: Record<string, LogLevel> = {
  development: "debug",
  dev: "debug",
  staging: "info",
  test: "warn",
  production: "warn",
  prod: "warn",
};

let currentLevel: LogLevel | null = null;

function getConfiguredLevel(): LogLevel {
  if (currentLevel !== null) {
    return currentLevel;
  }
  if (process.env.LOG_LEVEL) {
    const raw = process.env.LOG_LEVEL.toLowerCase() as LogLevel;
    if (raw in LEVEL_RANK) {
      return raw;
    }
  }
  const env = (process.env.NODE_ENV || "development").toLowerCase();
  return ENV_LEVEL_MAP[env] || "info";
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[getConfiguredLevel()];
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!shouldEmit(level)) return;
  const entry: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    correlation_id: getCorrelationId(),
    environment: process.env.NODE_ENV || "development",
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

export function setLogLevel(level: LogLevel): void {
  if (!(level in LEVEL_RANK)) {
    throw new Error(`Invalid log level: ${level}. Valid levels: ${Object.keys(LEVEL_RANK).join(", ")}`);
  }
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return getConfiguredLevel();
}

export function getLogLevels(): Record<LogLevel, number> {
  return { ...LEVEL_RANK };
}
