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

export async function signAndSubmit(
  client: rpc.Server,
  preparedXdr: string,
  keypair: Keypair
): Promise<string> {
  const tx = TransactionBuilder.fromXDR(preparedXdr, networkPassphrase);
  tx.sign(keypair);

  const result = await client.sendTransaction(tx);
  if (result.status === "ERROR") {
    throw new Error(`Send error: ${JSON.stringify(result.errorResult)}`);
  }

  let getResult: rpc.Api.GetTransactionResponse;
  let attempts = 0;
  do {
    await new Promise((r) => setTimeout(r, 1500));
    getResult = await client.getTransaction(result.hash);
    if (++attempts > 20) throw new Error("Transaction confirmation timeout");
  } while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND);

  if (getResult.status === rpc.Api.GetTransactionStatus.FAILED)
    throw new Error("Transaction failed on-chain");

  return result.hash;
}
