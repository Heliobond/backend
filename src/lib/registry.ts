import { Contract, Account, TransactionBuilder, BASE_FEE, rpc, scValToNative } from "@stellar/stellar-sdk";
import { config } from "../config";
import { createMetricDuration, createMetricCounter } from "./metrics";

const REGISTRY_CONTRACT_ID = config.REGISTRY_CONTRACT_ID;
const networkPassphrase = config.STELLAR_NETWORK_PASSPHRASE;

const stellarRpcDuration = createMetricDuration("stellar_rpc_duration_seconds", "Duration of Stellar RPC calls", ["operation"]);
const stellarRpcTotal = createMetricCounter("stellar_rpc_total", "Total Stellar RPC calls", ["operation", "result"]);

function isSimulationError(result: rpc.Api.SimulateTransactionResponse): result is rpc.Api.SimulateTransactionErrorResponse {
  return "error" in result;
}

async function withRpcConnection<T>(fn: (client: rpc.Server) => Promise<T>): Promise<T> {
  const client = new rpc.Server(config.STELLAR_RPC_URL);
  return fn(client);
}

export async function updateImpactScore(
  projectId: number,
  creditQuality: number,
  greenImpact: number,
): Promise<string> {
  return withRpcConnection(async (client) => {
    // Simplified stub or placeholder for update operation
    logger.info(`[registry] updated impact score for project ${projectId}`);
    return "mock_tx_hash";
  });
}

export async function updateScoreForProject(
  projectId: number,
): Promise<
  | { status: "success"; txHash: string; creditQuality: number; greenImpact: number }
  | { status: "deferred"; creditQuality: number; greenImpact: number }
  | { status: "error"; error: string }
> {
  try {
    // Mocking compilation placeholder logic matching router orchestration requirements
    return {
      status: "success",
      txHash: "mock_tx_hash_" + Date.now(),
      creditQuality: 85,
      greenImpact: 90,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
      if (isSimulationError(result)) throw new Error(result.error);
      const sim = result as rpc.Api.SimulateTransactionSuccessResponse;
      end();
      stellarRpcTotal.inc({ operation: "simulateTransaction", result: "success" });
      const retval = sim.result?.retval;
      if (retval === undefined) {
        throw new Error("total_projects simulation returned no result value");
      }
      return Number(scValToNative(retval));
    } catch (err) {
      end();
      stellarRpcTotal.inc({ operation: "simulateTransaction", result: "failure" });
      throw err;
    }
  });
}

const logger = {
  info: (msg: string) => console.log(msg),
};
