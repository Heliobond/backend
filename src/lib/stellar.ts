import {
  Keypair,
  rpc,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { RpcConnectionPool } from "./db-pool";

dotenv.config();

const NETWORK = process.env.STELLAR_NETWORK as "testnet" | "mainnet";

export const networkPassphrase =
  NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

// ── RPC outage tracking ─────────────────────────────────────────────────────
let lastRpcSuccess = Date.now();
let rpcOutageStart: number | null = null;
let consecutiveRpcFailures = 0;

export function recordRpcSuccess(): void {
  lastRpcSuccess = Date.now();
  rpcOutageStart = null;
  consecutiveRpcFailures = 0;
}

export function recordRpcFailure(): void {
  consecutiveRpcFailures++;
  if (rpcOutageStart === null) {
    rpcOutageStart = Date.now();
  }
}

export function isRpcAvailable(): boolean {
  return rpcOutageStart === null;
}

export function getRpcStatus(): {
  available: boolean;
  consecutiveFailures: number;
  outageDurationMs: number | null;
  lastSuccessAgoMs: number;
} {
  const now = Date.now();
  return {
    available: rpcOutageStart === null,
    consecutiveFailures: consecutiveRpcFailures,
    outageDurationMs: rpcOutageStart !== null ? now - rpcOutageStart : null,
    lastSuccessAgoMs: now - lastRpcSuccess,
  };
}

export function isRpcOutageExtended(thresholdMs: number = 300_000): boolean {
  if (rpcOutageStart === null) return false;
  return Date.now() - rpcOutageStart > thresholdMs;
}

// ── Connection pool ─────────────────────────────────────────────────────────

export const rpcPool = new RpcConnectionPool({
  rpcUrl: process.env.RPC_URL || "https://soroban-testnet.stellar.org",
  allowHttp: false,
  minConnections: parseInt(process.env.DB_POOL_MIN || "2", 10),
  maxConnections: parseInt(process.env.DB_POOL_MAX || "10", 10),
  acquireTimeoutMs: parseInt(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS || "5000", 10),
  healthCheckIntervalMs: parseInt(process.env.DB_POOL_HEALTH_CHECK_INTERVAL_MS || "30000", 10),
});

export function withRpcConnection<T>(fn: (client: rpc.Server) => Promise<T>): Promise<T> {
  return rpcPool.withConnection(fn).then(
    (result) => {
      recordRpcSuccess();
      return result;
    },
    (err) => {
      recordRpcFailure();
      throw err;
    },
  );
}

export function getAdminKeypair(): Keypair {
  const secretKey = process.env.ADMIN_SECRET_KEY;
  if (!secretKey) throw new Error("ADMIN_SECRET_KEY not set");
  return Keypair.fromSecret(secretKey);
}

export interface TimeoutErrorContext {
  hash: string;
  attempts: number;
  totalWaitMs: number;
}

export class RpcUnreachableError extends Error {
  constructor(cause: string) {
    super(`Stellar RPC unreachable: ${cause}`);
    this.name = "RpcUnreachableError";
  }
}

export class TransactionTimeoutError extends Error {
  readonly hash: string;
  readonly attempts: number;
  readonly totalWaitMs: number;

  constructor(context: TimeoutErrorContext) {
    const msg = `Transaction confirmation timeout: hash=${context.hash}, attempts=${context.attempts}, totalWaitMs=${context.totalWaitMs}`;
    super(msg);
    this.name = "TransactionTimeoutError";
    this.hash = context.hash;
    this.attempts = context.attempts;
    this.totalWaitMs = context.totalWaitMs;
  }
}

export class TransactionSendError extends Error {
  readonly hash?: string;

  constructor(hash: string | undefined, detail: string) {
    const msg = hash
      ? `Transaction send error: hash=${hash}, detail=${detail}`
      : `Transaction send error: ${detail}`;
    super(msg);
    this.name = "TransactionSendError";
    this.hash = hash;
  }
}

export class TransactionFailedError extends Error {
  readonly hash: string;
  readonly onChainError: string;

  constructor(hash: string, onChainError: string) {
    super(`Transaction failed on-chain: hash=${hash}, error=${onChainError}`);
    this.name = "TransactionFailedError";
    this.hash = hash;
    this.onChainError = onChainError;
  }
}

export async function signAndSubmit(
  client: rpc.Server,
  preparedXdr: string,
  keypair: Keypair,
  maxAttempts: number = 20,
  retryDelayMs: number = 1500,
): Promise<string> {
  const tx = TransactionBuilder.fromXDR(preparedXdr, networkPassphrase);
  tx.sign(keypair);

  const result = await client.sendTransaction(tx);
  if (result.status === "ERROR") {
    throw new TransactionSendError(result.hash, JSON.stringify(result.errorResult));
  }

  let getResult: rpc.Api.GetTransactionResponse;
  let attempts = 0;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    do {
      await new Promise<void>((r) => { timer = setTimeout(r, retryDelayMs); });
      timer = undefined;
      getResult = await client.getTransaction(result.hash);
      attempts++;
      if (attempts >= maxAttempts) {
        const totalWaitMs = Date.now() - startedAt;
        const ctx: TimeoutErrorContext = { hash: result.hash, attempts, totalWaitMs };
        console.error(`[stellar] timeout: hash=${result.hash}, attempts=${attempts}, totalWaitMs=${totalWaitMs}`);
        throw new TransactionTimeoutError(ctx);
      }
    } while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
    const onChainError = (getResult as any).resultXdr
      ? `resultXdr: ${(getResult as any).resultXdr}`
      : "unknown on-chain error";
    throw new TransactionFailedError(result.hash, onChainError);
  }

  return result.hash;
}
