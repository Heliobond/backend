/**
 * Wallet authentication for creator-facing endpoints (#655 / #771).
 *
 * A creator is authenticated by the Stellar account they control. The account
 * address travels in `x-wallet-address`. When `WALLET_AUTH_REQUIRE_SIGNATURE`
 * is `true` (or a signature is supplied), the request must also carry
 * `x-wallet-signature` (base64 Ed25519) and `x-wallet-timestamp`, proving
 * ownership of the account by signing a canonical challenge over the request.
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
    }
  }
}

const ADDRESS_HEADER = "x-wallet-address";
const SIGNATURE_HEADER = "x-wallet-signature";
const TIMESTAMP_HEADER = "x-wallet-timestamp";
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

function signatureRequired(): boolean {
  return (process.env.WALLET_AUTH_REQUIRE_SIGNATURE ?? "").toLowerCase() === "true";
}

/** Canonical challenge string a client signs (also documented for clients). */
export function walletChallenge(
  timestamp: string,
  method: string,
  path: string,
  body: unknown,
): string {
  const bodyHash = createHash("sha256")
    .update(typeof body === "string" ? body : JSON.stringify(body ?? {}))
    .digest("hex");
  return `heliobond-wallet-auth:${timestamp}:${method.toUpperCase()}:${path}:${bodyHash}`;
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
  const challenge = walletChallenge(timestamp, req.method, `${req.baseUrl}${req.path}`, req.body);
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
