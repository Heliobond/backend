import { Request, Response, NextFunction } from "express";
import { ApiError } from "./errors";

const MAX_STRING_LENGTH = 10_000;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_DEPTH = 5;

// Detects classic SQL injection sequences: comment markers, UNION SELECT, tautologies, DDL chains
const SQL_INJECTION_RE =
  /('[\s]*(\bor\b|\band\b)[\s]*('|\d))|(;\s*\b(drop|delete|truncate|alter|exec)\b)|(\bunion\b[\s]+\bselect\b)|(--\s)|(\/\*)/i;

// Detects shell execution sequences: backtick execution, $(...), ${...}
const COMMAND_INJECTION_RE = /`[^`]*`|\$\([^)]+\)|\$\{[^}]+\}/;

// Detects ../  ..\  and URL-encoded variants (%2e%2e)
const PATH_TRAVERSAL_RE = /\.\.[/\\]|[/\\]\.\.|%2e%2e/i;

function sanitizeString(key: string, value: string): string {
  if (value.length > MAX_STRING_LENGTH) {
    throw new ApiError(
      400,
      "input_too_long",
      `Field "${key}" exceeds the maximum allowed length of ${MAX_STRING_LENGTH} characters`,
    );
  }

  if (SQL_INJECTION_RE.test(value)) {
    throw new ApiError(400, "invalid_input", `Field "${key}" contains a disallowed SQL pattern`);
  }

  if (COMMAND_INJECTION_RE.test(value)) {
    throw new ApiError(
      400,
      "invalid_input",
      `Field "${key}" contains a disallowed command injection sequence`,
    );
  }

  if (PATH_TRAVERSAL_RE.test(value)) {
    throw new ApiError(
      400,
      "invalid_input",
      `Field "${key}" contains a path traversal sequence`,
    );
  }

  // Strip HTML/script tags for XSS prevention
  return value.replace(/<[^>]*>/g, "");
}

function sanitizeValue(key: string, value: unknown, depth = 0): unknown {
  if (depth > MAX_OBJECT_DEPTH) {
    throw new ApiError(400, "invalid_input", "Request body exceeds the maximum nesting depth");
  }

  if (typeof value === "string") {
    return sanitizeString(key, value);
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      throw new ApiError(
        400,
        "input_too_long",
        `Field "${key}" exceeds the maximum array length of ${MAX_ARRAY_LENGTH}`,
      );
    }
    return value.map((item, i) => sanitizeValue(`${key}[${i}]`, item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeValue(k, v, depth + 1);
    }
    return result;
  }

  return value;
}

export function sanitizeInputs(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (req.body !== undefined && req.body !== null) {
      req.body = sanitizeValue("body", req.body);
    }

    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") {
        sanitizeString(key, value);
      }
    }

    for (const [key, value] of Object.entries(req.params)) {
      if (typeof value === "string") {
        sanitizeString(key, value);
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}
