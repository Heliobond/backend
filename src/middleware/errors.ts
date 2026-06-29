import { Request, Response, NextFunction } from "express";
import { getCorrelationId } from "../lib/correlation";

/**
 * Structured API error. Thrown from anywhere in a route handler (sync or async)
 * and rendered as `{ error, message }` JSON by `errorHandler`.
 *
 * `error` is a stable, machine-readable code; `message` is human-readable.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "bad_request", message);
}

/**
 * Parse and validate a `:id` style path/route param as a positive integer.
 * Throws `ApiError` (400) on anything that isn't a whole number >= 1.
 */
export function parseProjectId(raw: string | string[] | undefined, field = "id"): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "" || !/^\d+$/.test(value)) {
    throw badRequest(`${field} must be a positive integer`);
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw badRequest(`${field} must be a positive integer`);
  }
  return id;
}

/**
 * Parse an optional non-negative integer query param, falling back to `fallback`.
 * Throws `ApiError` (400) when the param is present but not a valid integer.
 */
export function parseOptionalInt(
  raw: string | string[] | undefined,
  field: string,
  fallback: number
): number {
  if (raw === undefined) return fallback;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!/^\d+$/.test(value)) {
    throw badRequest(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

/** JSON 404 for unmatched routes — keeps clients off Express' HTML default. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: "not_found",
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
}

/**
 * Terminal error-handling middleware. Must be registered last and keep all four
 * args so Express recognises it as an error handler.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (res.headersSent) return;

  const correlationId = getCorrelationId();

  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.code, message: err.message, correlation_id: correlationId });
    return;
  }

  // Body parser raises a SyntaxError (with a `body` field) on malformed JSON.
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "bad_request", message: "Request body is not valid JSON", correlation_id: correlationId });
    return;
  }

  console.error("[error]", err);
  res.status(500).json({ error: "internal_error", message: "An unexpected error occurred", correlation_id: correlationId });
}
