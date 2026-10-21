/**
 * Wallet authentication for creator-facing endpoints (#655 / #771 / #832).
 *
 * A creator is authenticated by the Stellar account they control. The account
 * address travels in `x-wallet-address`, together with a signature over the
 * canonical challenge in `x-wallet-signature` (base64 Ed25519) and the
 * challenge timestamp in `x-wallet-timestamp`.
 *
 * Signature verification is on by default (#832). Setting
 * `WALLET_AUTH_REQUIRE_SIGNATURE=false` explicitly disables it for a dev or
 * test setup; previously the flag defaulted to `false` and `.env.example`
 * shipped that default, so creator identity could be spoofed by any client
 * that chose a Stellar address.
 *
 * Only public material is involved — the server never sees or stores a secret.
 */
import { Request, Response, NextFunction } from "express";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import { errorBody } from "./errors";

declare global {
  namespace Express {
    interface Request {
      /** Set by `walletAuth` once the wallet address is validated. */
      walletAddress?: string;
      /** Raw request body bytes captured by `express.json({ verify })`. */
      rawBody?: Buffer;
    }
  }
}

const ADDRESS_HEADER = "x-wallet-address";
const SIGNATURE_HEADER = "x-wallet-signature";
const TIMESTAMP_HEADER = "x-wallet-timestamp";
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

function signatureRequired(): boolean {
  // Fail closed: the default is `true`. Only an explicit opt-out via
  // `WALLET_AUTH_REQUIRE_SIGNATURE=false` disables signature verification,
  // and that opt-out is intended for local dev and tests.
  const raw = (process.env.WALLET_AUTH_REQUIRE_SIGNATURE ?? "").toLowerCase();
  return raw !== "false" && raw !== "0";
}

/**
 * Deterministic JSON serialization: sorted keys at every level, no whitespace.
 * Used as a fallback when the raw request body bytes were not captured, so
 * verifier and signer agree regardless of `JSON.stringify` key order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Canonical challenge string a client signs. Pass the exact body bytes the
 * client will send on the wire whenever possible; passing an object falls
 * back to `canonicalJson(body)` so both sides derive the same hash even if
 * `JSON.stringify` key order differs between request builder and parser.
 */
export function walletChallenge(
  timestamp: string,
  method: string,
  path: string,
  body: string | Buffer | unknown,
): string {
  const bodyBytes =
    typeof body === "string"
      ? body
      : Buffer.isBuffer(body)
        ? body.toString("utf8")
        : body == null
          ? ""
          : canonicalJson(body);
  const bodyHash = createHash("sha256").update(bodyBytes).digest("hex");
  return `heliobond-wallet-auth:${timestamp}:${method.toUpperCase()}:${path}:${bodyHash}`;
}

/**
 * Server-side variant: hash whatever the client actually sent. Uses the raw
 * request body bytes when `express.json({ verify })` captured them, otherwise
 * falls back to a canonical JSON serialization of the parsed body so a
 * client that chose to canonicalize instead of preserving raw bytes still
 * verifies.
 */
function challengeForRequest(req: Request, timestamp: string): string {
  const raw = req.rawBody;
  const bodyBytes =
    raw && raw.length > 0
      ? raw.toString("utf8")
      : req.body === undefined
        ? ""
        : canonicalJson(req.body);
  return walletChallenge(timestamp, req.method, `${req.baseUrl}${req.path}`, bodyBytes);
}

function parseTimestampMs(timestamp: string): number | null {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed;
}

function verifySignature(
  req: Request,
  address: string,
  signature: string,
  timestamp: string,
): boolean {
  const timestampMs = parseTimestampMs(timestamp);
  if (timestampMs === null || Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_AGE_MS) {
    return false;
  }
  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(address);
  } catch {
    return false;
  }
  const challenge = challengeForRequest(req, timestamp);
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  try {
    return keypair.verify(Buffer.from(challenge, "utf8"), signatureBytes);
  } catch {
    return false;
  }
}

export function walletAuth(req: Request, res: Response, next: NextFunction): void {
  const address = String(req.header(ADDRESS_HEADER) ?? "").trim();
  if (!address || !StrKey.isValidEd25519PublicKey(address)) {
    res.status(401).json(errorBody("unauthorized", `Missing or invalid ${ADDRESS_HEADER} header`));
    return;
  }

  const signature = req.header(SIGNATURE_HEADER);
  const timestamp = req.header(TIMESTAMP_HEADER);
  if (signature !== undefined || signatureRequired()) {
    if (!signature || !timestamp) {
      res
        .status(401)
        .json(
          errorBody("unauthorized", `Missing ${SIGNATURE_HEADER} or ${TIMESTAMP_HEADER} header`),
        );
      return;
    }
    if (!verifySignature(req, address, signature, timestamp)) {
      res.status(401).json(errorBody("unauthorized", "Invalid wallet signature"));
      return;
    }
  }

  req.walletAddress = address;
  next();
}
