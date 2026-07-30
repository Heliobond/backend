import { Request, Response, NextFunction } from "express";

/**
 * Standard error response shape returned by `errorHandler` and any route that
 * reports an error directly: `{ error: { code, message } }`. `code` is a
 * stable, machine-readable identifier; `message` is human-readable.
 */
export interface ErrorBody {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/**
 * Structured API error. Thrown from anywhere in a route handler (sync or async)
 * and rendered as `{ error: { code, message } }` JSON by `errorHandler`.
 *
 * `code` is a stable, machine-readable identifier; `message` is human-readable.
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

/** Default inclusive upper bound for project IDs; overridable via MAX_PROJECT_ID. */
export const DEFAULT_MAX_PROJECT_ID = 1_000_000;

/**
 * Resolved inclusive upper bound for project IDs.
 *
 * Read per call so the bound can be raised without a rebuild as the registry
 * grows. A missing, non-numeric or non-positive value falls back to the default
 * rather than throwing: a typo in this variable must not turn every project
 * lookup into a 500.
 */
export function maxProjectId(): number {
  const raw = process.env.MAX_PROJECT_ID;
  if (!raw) return DEFAULT_MAX_PROJECT_ID;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_MAX_PROJECT_ID;
  return parsed;
}

/**
 * Parse and validate a `:id` style path/route param as a project ID.
 *
 * Accepts only a whole number in `[1, MAX_PROJECT_ID]` (default 1..1000000).
 * The digits-only regex rejects floats (`1.5`), signs (`-5`, `+5`), whitespace
 * and exponent notation (`1e6`) before any numeric coercion happens, and the
 * upper bound keeps absurd IDs from reaching downstream lookups. Anything else
 * throws `ApiError` (400).
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

  const max = maxProjectId();
  if (id > max) {
    throw badRequest(`${field} must be between 1 and ${max}`);
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
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw badRequest(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

/** JSON 404 for unmatched routes — keeps clients off Express' HTML default. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(errorBody("not_found", `Cannot ${req.method} ${req.originalUrl}`));
}

/**
 * Terminal error-handling middleware. Must be registered last and keep all four
 * args so Express recognises it as an error handler.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (err instanceof ApiError) {
    res.status(err.status).json(errorBody(err.code, err.message));
    return;
  }

  // Body parser raises a SyntaxError (with a `body` field) on malformed JSON.
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json(errorBody("bad_request", "Request body is not valid JSON"));
    return;
  }

  // Body parser raises PayloadTooLargeError when the request body exceeds the configured limit.
  if (err instanceof Error && "statusCode" in err && err.statusCode === 413) {
    res.status(413).json(errorBody("payload_too_large", "Request body is too large"));
    return;
  }

  console.error("[error]", err);
  res.status(500).json(errorBody("internal_error", "An unexpected error occurred"));
}
