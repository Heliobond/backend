import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  BASE_FEE,
  scValToNative,
  rpc,
  Account,
} from "@stellar/stellar-sdk";
import {
  withRpcConnection,
  networkPassphrase,
  getAdminKeypair,
  signAndSubmit,
  RpcDegradedError,
  withRpcRetry,
} from "./stellar";
import { config } from "../config";
import { stellarRpcDuration, stellarRpcTotal } from "./prometheus";

// Re-export so callers (scoreService, routes/batch) can `instanceof`-check the
// exact error class the RPC layer throws, instead of comparing against a
// sibling class that `instanceof` can never match.
export { RpcDegradedError };

if (!config.PROJECT_REGISTRY_CONTRACT_ID) {
  throw new Error("PROJECT_REGISTRY_CONTRACT_ID env var is required");
}
const REGISTRY_CONTRACT_ID = config.PROJECT_REGISTRY_CONTRACT_ID;

/**
 * Thrown when an idempotency key collision is detected — i.e. the same
 * project score update has already been submitted within IDEMPOTENCY_TTL_MS.
 * Callers can catch this specific error to distinguish "already done" from a
 * real RPC failure.
 */
export class DuplicateSubmissionError extends Error {
  public readonly idempotencyKey: string;
  public readonly recordedAt: number;

  constructor(key: string, recordedAt: number) {
    super(
      `Duplicate submission rejected — idempotency key "${key}" was already seen ` +
        `at ${new Date(recordedAt).toISOString()}`,
    );
    this.name = "DuplicateSubmissionError";
    this.idempotencyKey = key;
    this.recordedAt = recordedAt;
  }
}

/**
 * Thrown when an account fetch returns a stale sequence number (#540).
 */
export class StaleSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSequenceError";
  }
}

// Local sequence tracker to guard against sequence conflicts and duplicate replay (#540)
let localSequence: bigint | null = null;
let submissionMutex: Promise<unknown> = Promise.resolve();

export function getLocalSequence(): bigint | null {
  return localSequence;
}

export function resetLocalSequence(): void {
  localSequence = null;
}

export async function updateImpactScore(
  projectId: number,
  creditQuality: number,
  greenImpact: number,
  /** Pre-generated idempotency key (for tracing/logging). Callers are
   *  responsible for running the idempotency check before this call. */
  idempotencyKey?: string,
): Promise<string> {
  const execute = async () => {
    return withRpcConnection(async (client) => {
      const keypair = getAdminKeypair();
      const account = await withRpcRetry(
        () => client.getAccount(keypair.publicKey()),
        "stellar:getAccount",
      );

      const rawSeq =
        typeof account.sequenceNumber === "function"
          ? account.sequenceNumber()
          : (account as any).sequence;
      const fetchedSeq = BigInt(rawSeq);
      if (localSequence !== null && fetchedSeq < localSequence) {
        throw new StaleSequenceError(
          `Stale sequence number: fetched ${rawSeq}, expected at least ${localSequence}`,
        );
      }

      // Track sequence on first fetch or if chain has advanced
      if (localSequence === null || fetchedSeq > localSequence) {
        localSequence = fetchedSeq;
      }

      const contract = new Contract(REGISTRY_CONTRACT_ID);

      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
        .addOperation(
          contract.call(
            "update_impact_score",
            nativeToScVal(projectId, { type: "u32" }),
            nativeToScVal(creditQuality, { type: "u32" }),
            nativeToScVal(greenImpact, { type: "u32" }),
          ),
        )
        .setTimeout(config.TX_TIMEOUT_SECONDS)
        .build();

      const prepared = await withRpcRetry(
        () => client.prepareTransaction(tx),
        "stellar:prepareTransaction",
      );
      const hash = await signAndSubmit(client, prepared.toXDR(), keypair);

      // Increment sequence number after successful submission
      localSequence += 1n;

      return hash;
    });
  };

  const nextMutex = submissionMutex.then(execute, execute);
  submissionMutex = nextMutex.catch(() => {});
  return nextMutex;
}

export async function getTotalProjects(): Promise<number> {
  return withRpcConnection(async (client) => {
    const contract = new Contract(REGISTRY_CONTRACT_ID);
    const dummyAccount = new Account(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "0",
    );

    const tx = new TransactionBuilder(dummyAccount, { fee: BASE_FEE, networkPassphrase })
      .addOperation(contract.call("total_projects"))
      .setTimeout(config.TX_TIMEOUT_SECONDS)
      .build();

    const end = stellarRpcDuration.startTimer({ operation: "simulateTransaction" });

    let sim: rpc.Api.SimulateTransactionResponse;
    try {
      sim = await withRpcRetry(() => client.simulateTransaction(tx), "stellar:simulateTransaction");
    } catch (err) {
      end();
      stellarRpcTotal.inc({ operation: "simulateTransaction", result: "failure" });
      throw err;
    }

    // A failed simulation carries a string `error` field; the success variants
    // do not. The `in` check narrows the union instead of relying on an `as`
    // cast or a non-null assertion (see #228).
    if ("error" in sim) {
      end();
      stellarRpcTotal.inc({ operation: "simulateTransaction", result: "failure" });
      throw new Error(sim.error);
    }

    const retval = sim.result?.retval;
    if (retval === undefined) {
      end();
      stellarRpcTotal.inc({ operation: "simulateTransaction", result: "failure" });
      throw new Error("total_projects simulation returned no result value");
    }

    end();
    stellarRpcTotal.inc({ operation: "simulateTransaction", result: "success" });
    return Number(scValToNative(retval));
  });
}
