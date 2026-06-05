import {
  Keypair,
  rpc,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import dotenv from "dotenv";
dotenv.config();

const NETWORK = process.env.STELLAR_NETWORK as "testnet" | "mainnet";

export const networkPassphrase =
  NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

export const rpcServer = new rpc.Server(
  process.env.RPC_URL || "https://soroban-testnet.stellar.org",
  { allowHttp: false }
);

export function getAdminKeypair(): Keypair {
  const secretKey = process.env.ADMIN_SECRET_KEY;
  if (!secretKey) throw new Error("ADMIN_SECRET_KEY not set");
  return Keypair.fromSecret(secretKey);
}

// Takes the XDR of a prepared tx, signs it, submits, and polls until confirmed.
export async function signAndSubmit(
  preparedXdr: string,
  keypair: Keypair
): Promise<string> {
  const tx = TransactionBuilder.fromXDR(preparedXdr, networkPassphrase);
  tx.sign(keypair);

  const result = await rpcServer.sendTransaction(tx);
  if (result.status === "ERROR") {
    throw new Error(`Send error: ${JSON.stringify(result.errorResult)}`);
  }

  let getResult: rpc.Api.GetTransactionResponse;
  let attempts = 0;
  do {
    await new Promise((r) => setTimeout(r, 1500));
    getResult = await rpcServer.getTransaction(result.hash);
    if (++attempts > 20) throw new Error("Transaction confirmation timeout");
  } while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND);

  if (getResult.status === rpc.Api.GetTransactionStatus.FAILED)
    throw new Error("Transaction failed on-chain");

  return result.hash;
}
