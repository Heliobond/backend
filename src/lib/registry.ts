import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  BASE_FEE,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import { withRpcConnection, networkPassphrase, getAdminKeypair, signAndSubmit } from "./stellar";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.PROJECT_REGISTRY_CONTRACT_ID) {
  throw new Error("PROJECT_REGISTRY_CONTRACT_ID env var is required");
}
const REGISTRY_CONTRACT_ID = process.env.PROJECT_REGISTRY_CONTRACT_ID;

export async function updateImpactScore(
  projectId: number,
  creditQuality: number,
  greenImpact: number
): Promise<string> {
  return withRpcConnection(async (client) => {
    const keypair = getAdminKeypair();
    const account = await client.getAccount(keypair.publicKey());
    const contract = new Contract(REGISTRY_CONTRACT_ID);

    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
      .addOperation(
        contract.call(
          "update_impact_score",
          nativeToScVal(projectId, { type: "u32" }),
          nativeToScVal(creditQuality, { type: "u32" }),
          nativeToScVal(greenImpact, { type: "u32" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await client.prepareTransaction(tx);
    return signAndSubmit(client, prepared.toXDR(), keypair);
  });
}

export async function getTotalProjects(): Promise<number> {
  return withRpcConnection(async (client) => {
    const keypair = getAdminKeypair();
    const account = await client.getAccount(keypair.publicKey());
    const contract = new Contract(REGISTRY_CONTRACT_ID);

    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
      .addOperation(contract.call("total_projects"))
      .setTimeout(30)
      .build();

    const result = await client.simulateTransaction(tx);
    if ("error" in result) throw new Error((result as { error: string }).error);
    const sim = result as rpc.Api.SimulateTransactionSuccessResponse;
    return Number(scValToNative(sim.result!.retval));
  });
}
