import { Keypair, rpc, Networks, TransactionBuilder, Account, xdr } from "@stellar/stellar-sdk";
import { config } from "../config";
import { logger } from "./logger";
import { RpcConnectionPool } from "./db-pool";
import { CircuitBreaker } from "./circuit-breaker";
import { withRetry, isTransientError } from "./retry";
import { stellarRpcDuration, stellarRpcTotal, txSubmissionTotal } from "./prometheus";

export const networkPassphrase =
  config.STELLAR_NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

export const rpcPool = new RpcConnectionPool({
  rpcUrl: config.RPC_URL,
  allowHttp: false,
  minConnections: config.DB_POOL_MIN,
  maxConnections: config.DB_POOL_MAX,
  acquireTimeoutMs: config.DB_POOL_ACQUIRE_TIMEOUT_MS,
  healthCheckIntervalMs: config.DB_POOL_HEALTH_CHECK_INTERVAL_MS,
});

// ── Circuit Breaker for Stellar RPC (#56) ────────────────────────────────────
export const rpcBreaker = new CircuitBreaker({
  failureThreshold: config.RPC_BREAKER_FAILURE_THRESHOLD,
  recoveryTimeoutMs: config.RPC_BREAKER_RECOVERY_TIMEOUT_MS,
  name: "StellarRPC",
});

// ── RPC health tracking (#56) ────────────────────────────────────────────────
let consecutiveFailures = 0;
let outageStartedAt: number | null = null;
let lastSuccessAt: number = Date.now();

function recordRpcSuccess(): void {
  consecutiveFailures = 0;
  outageStartedAt = null;
  lastSuccessAt = Date.now();
}

function recordRpcFailure(): void {
  consecutiveFailures++;
  if (outageStartedAt === null) outageStartedAt = Date.now();
}

export function isRpcAvailable(): boolean {
  return rpcBreaker.getState() !== "OPEN";
}

export function isRpcOutageExtended(thresholdMs: number): boolean {
  return outageStartedAt !== null && Date.now() - outageStartedAt >= thresholdMs;
}

export function getRpcStatus(): {
  consecutiveFailures: number;
  outageDurationMs: number;
  lastSuccessAgoMs: number;
} {
  return {
    consecutiveFailures,
    outageDurationMs: outageStartedAt !== null ? Date.now() - outageStartedAt : 0,
    lastSuccessAgoMs: Date.now() - lastSuccessAt,
  };
}

export function withRpcConnection<T>(fn: (client: rpc.Server) => Promise<T>): Promise<T> {
  return rpcBreaker.execute(
    () => rpcPool.withConnection(fn),
    async () => {
      throw new RpcDegradedError("Stellar RPC circuit is OPEN – request rejected");
    },
  );
}

// ── Admin keypair cache (#227) ───────────────────────────────────────────────
// Deriving an Ed25519 keypair from the secret is pure CPU work and the secret
// does not change during the process lifetime, so derive once and reuse. The
// secret it was derived from is cached alongside it: if the configured secret
// ever differs, the cache is rebuilt rather than handing back a stale keypair.
let cachedAdminKeypair: Keypair | null = null;
let cachedAdminSecret: string | null = null;

export function getAdminKeypair(): Keypair {
  const secretKey = config.ADMIN_SECRET_KEY;
  if (!secretKey) throw new Error("ADMIN_SECRET_KEY not set");

  if (cachedAdminKeypair === null || cachedAdminSecret !== secretKey) {
    cachedAdminKeypair = Keypair.fromSecret(secretKey);
    cachedAdminSecret = secretKey;
  }
  return cachedAdminKeypair;
}

/** Drop the cached keypair. Intended for tests that swap the configured secret. */
export function resetAdminKeypairCache(): void {
  cachedAdminKeypair = null;
  cachedAdminSecret = null;
}

// ── FIXED SEQUENCE & CONCURRENCY QUEUE MANAGEMENT ───────────────────────────
let submissionQueue = Promise.resolve();
// Track the latest local sequence number to prevent simultaneous thread collisions
let localSequenceTracker: bigint | null = null;

/** Re-exported so registry/cron can catch it for queue-deferral logic. */
export class RpcDegradedError extends Error {
  constructor(msg = "RPC is degraded") {
    super(msg);
    this.name = "RpcDegradedError";
  }
}

export async function signAndSubmit(
  client: rpc.Server,
  preparedXdr: string,
  keypair: Keypair,
): Promise<string> {
  // Queue conflicting sequential transactions cleanly using a single unified promise chain
  return new Promise((resolve, reject) => {
    submissionQueue = submissionQueue
      .then(async () => {
        const end = stellarRpcDuration.startTimer({ operation: "signAndSubmit" });
        try {
          const hash = await _executeSignAndSubmitWithRetry(client, preparedXdr, keypair);
          recordRpcSuccess();
          end();
          stellarRpcTotal.inc({ operation: "signAndSubmit", result: "success" });
          txSubmissionTotal.inc({ result: "success" });
          resolve(hash);
        } catch (error) {
          if (isTransientError(error)) recordRpcFailure();
          end();
          stellarRpcTotal.inc({ operation: "signAndSubmit", result: "failure" });
          txSubmissionTotal.inc({ result: "failure" });
          reject(error);
        }
      })
      .catch(() => {});
  });
}

async function _executeSignAndSubmitWithRetry(
  client: rpc.Server,
  preparedXdr: string,
  keypair: Keypair,
): Promise<string> {
  return withRetry(() => _attemptSubmit(client, preparedXdr, keypair), {
    maxAttempts: config.TX_MAX_RETRIES,
    baseDelayMs: config.TX_RETRY_BASE_DELAY_MS,
    maxDelayMs: config.TX_RETRY_MAX_DELAY_MS,
    jitter: 0.3,
    label: "stellar:signAndSubmit",
  });
}

async function _attemptSubmit(
  client: rpc.Server,
  preparedXdr: string,
  keypair: Keypair,
): Promise<string> {
  let tx = TransactionBuilder.fromXDR(preparedXdr, networkPassphrase) as any;

  // 1. Fetch latest sequence number from ledger state
  const accountKey = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: keypair.xdrPublicKey(),
    }),
  );

  const accountResponse = await client.getLedgerEntries(accountKey);

  if (!accountResponse.entries || accountResponse.entries.length === 0) {
    logger.warn("stellar: getLedgerEntries returned no account entry, retrying");
    throw new Error("getLedgerEntries returned empty response for admin account");
  }

  const accountEntry = accountResponse.entries[0].val.account();
  if (!accountEntry) {
    logger.warn("stellar: account entry is malformed, retrying");
    throw new Error("getLedgerEntries returned malformed account entry");
  }

  const onChainSequence = BigInt(accountEntry.seqNum().toString());

  // Use the higher value between live ledger and local in-memory tracker
  if (localSequenceTracker === null || onChainSequence > localSequenceTracker) {
    localSequenceTracker = onChainSequence;
  }

  const targetSequence = (localSequenceTracker + 1n).toString();
  const account = new Account(keypair.publicKey(), targetSequence);

  const builder = new TransactionBuilder(account, {
    fee: tx.fee,
    networkPassphrase,
    timebounds: tx.timeBounds || (tx.tx ? tx.tx.timeBounds : undefined),
  });

  for (const op of tx.operations) {
    builder.addOperation(op);
  }

  tx = builder.build();

  tx.sign(keypair);
  const result = await client.sendTransaction(tx);

  if (result.status === "ERROR") {
    const errorString = JSON.stringify(result.errorResult);
    const isSequenceConflict =
      errorString.includes("tx_bad_seq") || errorString.includes("ERR_BAD_SEQ");

    if (isSequenceConflict) {
      // Force re-fetch from chain on next attempt
      localSequenceTracker = null;
    }

    throw new Error(`Send error: ${errorString}`);
  }

  // Successful dispatch – increment local tracker
  if (localSequenceTracker !== null) {
    localSequenceTracker += 1n;
  }

  // 2. Poll for confirmation
  let getResult: rpc.Api.GetTransactionResponse | undefined;
  let pollAttempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pollIntervalMs = config.POLL_INTERVAL_MS;

  try {
    do {
      await new Promise<void>((r) => {
        timer = setTimeout(r, pollIntervalMs);
      });
      timer = undefined;
      getResult = await client.getTransaction(result.hash);
      if (++pollAttempts > config.POLL_MAX_ATTEMPTS)
        throw new Error("Transaction confirmation timeout");
    } while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // The loop above always assigns before exiting normally, but the check keeps
  // that a runtime guarantee rather than an assertion the compiler has to trust.
  if (getResult === undefined) {
    throw new Error("Transaction confirmation never returned a result");
  }

  if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed on-chain");
  }

  return result.hash;
}
