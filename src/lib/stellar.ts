import { Keypair, rpc, Networks, TransactionBuilder, Account, xdr } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { RpcConnectionPool } from "./db-pool";

dotenv.config();

const NETWORK = process.env.STELLAR_NETWORK as "testnet" | "mainnet";

export const networkPassphrase = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

export const rpcPool = new RpcConnectionPool({
  rpcUrl: process.env.RPC_URL || "https://soroban-testnet.stellar.org",
  allowHttp: false,
  minConnections: parseInt(process.env.DB_POOL_MIN || "2", 10),
  maxConnections: parseInt(process.env.DB_POOL_MAX || "10", 10),
  acquireTimeoutMs: parseInt(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS || "5000", 10),
  healthCheckIntervalMs: parseInt(process.env.DB_POOL_HEALTH_CHECK_INTERVAL_MS || "30000", 10),
});

export function withRpcConnection<T>(fn: (client: rpc.Server) => Promise<T>): Promise<T> {
  return rpcPool.withConnection(fn);
}

export function getAdminKeypair(): Keypair {
  const secretKey = process.env.ADMIN_SECRET_KEY;
  if (!secretKey) throw new Error("ADMIN_SECRET_KEY not set");
  return Keypair.fromSecret(secretKey);
}

let submissionQueue = Promise.resolve();

export async function signAndSubmit(
  client: rpc.Server,
  preparedXdr: string,
  keypair: Keypair,
): Promise<string> {
  return new Promise((resolve, reject) => {
    submissionQueue = submissionQueue
      .then(async () => {
        try {
          const hash = await _executeSignAndSubmitWithRetry(client, preparedXdr, keypair);
          resolve(hash);
        } catch (error) {
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
  maxRetries = 3,
): Promise<string> {
  let attempts = 0;

  while (attempts < maxRetries) {
    attempts++;

    let tx = TransactionBuilder.fromXDR(preparedXdr, networkPassphrase) as any;

    try {
      const accountKey = xdr.LedgerKey.account(
        new xdr.LedgerKeyAccount({
          accountId: keypair.xdrPublicKey(),
        }),
      );

      const accountResponse = await client.getLedgerEntries(accountKey);

      if (accountResponse.entries && accountResponse.entries.length > 0) {
        const accountEntry = accountResponse.entries[0].val.account();
        if (accountEntry) {
          const currentSequence = accountEntry.seqNum().toString();
          const account = new Account(keypair.publicKey(), currentSequence);

          const builder = new TransactionBuilder(account, {
            fee: tx.fee,
            networkPassphrase,
            timebounds: tx.timeBounds || (tx.tx ? tx.tx.timeBounds : undefined),
          });

          for (const op of tx.operations) {
            builder.addOperation(op);
          }

          tx = builder.build();
        }
      }

      tx.sign(keypair);

      const result = await client.sendTransaction(tx);

      if (result.status === "ERROR") {
        const errorString = JSON.stringify(result.errorResult);
        const isSequenceConflict =
          errorString.includes("tx_bad_seq") || errorString.includes("ERR_BAD_SEQ");

        if (isSequenceConflict && attempts < maxRetries) {
          console.warn(
            `Sequence conflict detected. Retrying submission (${attempts}/${maxRetries})...`,
          );
          await new Promise((r) => setTimeout(r, 500 * attempts));
          continue;
        }

        throw new Error(`Send error: ${errorString}`);
      }

      let getResult: rpc.Api.GetTransactionResponse;
      let pollAttempts = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        do {
          await new Promise<void>((r) => {
            timer = setTimeout(r, 1500);
          });
          timer = undefined;
          getResult = await client.getTransaction(result.hash);
          if (++pollAttempts > 20) throw new Error("Transaction confirmation timeout");
        } while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error("Transaction failed on-chain");
      }

      return result.hash;
    } catch (error: any) {
      if (attempts >= maxRetries) {
        throw error;
      }
      console.error(`Error encountered during submission lifecycle: ${error.message}. Retrying...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error("Transaction submission failed after maximum retry attempts.");
}
