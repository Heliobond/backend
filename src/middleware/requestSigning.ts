import { Request, Response, NextFunction } from "express";
import { createHmac } from "crypto";
import { timingSafeCompare } from "../lib/timing-safe";

const SIGNATURE_HEADER = "x-signature";
const TIMESTAMP_HEADER = "x-timestamp";
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes

function getSigningSecret(): string | undefined {
  return process.env.REQUEST_SIGNING_SECRET;
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
    res.status(401).json({ error: "Missing signature or timestamp header" });
    return;
  }

  const timestampMs = parseInt(timestamp, 10);
  if (isNaN(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_AGE_MS) {
    res.status(401).json({ error: "Request timestamp expired or invalid" });
    return;
  }

  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  const expected = computeSignature(secret, timestamp, req.method, req.path, body);

  if (!signaturesMatch(signature, expected)) {
    res.status(401).json({ error: "Invalid request signature" });
    return;
  }

  next();
}
