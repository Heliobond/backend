import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  BASE_FEE,
  scValToNative,
  rpc,
  Account,
} from "@stellar/stellar-sdk";
import { withRpcConnection, networkPassphrase, getAdminKeypair, signAndSubmit } from "./stellar";
import { config } from "../config";
import { stellarRpcDuration, stellarRpcTotal } from "./prometheus";

if (!config.PROJECT_REGISTRY_CONTRACT_ID) {
  throw new Error("PROJECT_REGISTRY_CONTRACT_ID env var is required");
}
const REGISTRY_CONTRACT_ID = config.PROJECT_REGISTRY_CONTRACT_ID;

export async function updateImpactScore(
  projectId: number,
  creditQuality: number,
  greenImpact: number,
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
          nativeToScVal(greenImpact, { type: "u32" }),
        ),
      )
      .setTimeout(config.TX_TIMEOUT_SECONDS)
      .build();

    const prepared = await client.prepareTransaction(tx);
    return signAndSubmit(client, prepared.toXDR(), keypair);
  });
}

/**
 * Narrowing guard for a failed simulation. Defined locally rather than using
 * the SDK's `rpc.Api.isSimulationError` so the check stays a plain shape test
 * and does not depend on that helper being present at runtime.
 */
function isSimulationError(
  sim: rpc.Api.SimulateTransactionResponse,
): sim is rpc.Api.SimulateTransactionErrorResponse {
  return "error" in sim && typeof sim.error === "string";
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
    try {
      const result = await client.simulateTransaction(tx);
      if ("error" in result) throw new Error((result as { error: string }).error);
      const sim = result as rpc.Api.SimulateTransactionSuccessResponse;
      end();
      stellarRpcTotal.inc({ operation: "simulateTransaction", result: "success" });
      return Number(scValToNative(sim.result!.retval));
    } catch (err) {
      end();
      stellarRpcTotal.inc({ operation: "simulateTransaction", result: "failure" });
      throw err;
    }
    const sim = await client.simulateTransaction(tx);
    if (isSimulationError(sim)) throw new Error(sim.error);

    const retval = sim.result?.retval;
    if (retval === undefined) {
      throw new Error("total_projects simulation returned no result value");
    }
    return Number(scValToNative(retval));
  });
}

export class RpcDegradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcDegradedError";
  }
}
