import { Request, Response, NextFunction } from "express";
import { createHmac } from "crypto";
import { config } from "../config";
import { timingSafeCompare } from "../lib/timing-safe";
import { errorBody } from "./errors";

const SIGNATURE_HEADER = "x-signature";
const TIMESTAMP_HEADER = "x-timestamp";
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes

function getSigningSecret(): string | undefined {
  return process.env.REQUEST_SIGNING_SECRET || config.REQUEST_SIGNING_SECRET;
}

/**
 * Deterministic JSON serialization: sorted keys at every level, no whitespace.
 * Used as a fallback when the raw request body bytes were not captured, so
 * the verifier and signer agree regardless of `JSON.stringify` key order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Return the exact bytes the client signed over. Prefers `req.rawBody`
 * captured by `express.json({ verify })`; otherwise falls back to a
 * canonical JSON serialization of the parsed body so a client that chose
 * to canonicalize still verifies. Hashing `JSON.stringify(req.body)` of
 * the parsed object (the previous behavior) depended on key order and
 * whitespace and produced intermittent 401s on otherwise-valid signatures.
 */
function bodyForSigning(req: Request): string {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (raw && raw.length > 0) return raw.toString("utf8");
  if (req.body === undefined || req.body === null) return "";
  if (typeof req.body === "string") return req.body;
  return canonicalJson(req.body);
}

function computeSignature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string,
): string {
  const payload = `${timestamp}:${method}:${path}:${body}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function signaturesMatch(a: string, b: string): boolean {
  return timingSafeCompare(a, b);
}

export function requestSigning(req: Request, res: Response, next: NextFunction): void {
  const secret = getSigningSecret();
  if (!secret) {
    next();
    return;
  }

  const signature = req.headers[SIGNATURE_HEADER] as string | undefined;
  const timestamp = req.headers[TIMESTAMP_HEADER] as string | undefined;

  if (signature === undefined || timestamp === undefined) {
    res.status(401).json(errorBody("unauthorized", "Missing signature or timestamp header"));
    return;
  }

  const timestampMs = parseInt(timestamp, 10);
  if (isNaN(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_AGE_MS) {
    res.status(401).json(errorBody("unauthorized", "Request timestamp expired or invalid"));
    return;
  }

  const body = bodyForSigning(req);
  const expected = computeSignature(secret, timestamp, req.method, req.path, body);

  if (!signaturesMatch(signature, expected)) {
    res.status(401).json(errorBody("unauthorized", "Invalid request signature"));
    return;
  }

  next();
}
