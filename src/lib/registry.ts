import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  BASE_FEE,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import { withRpcConnection, networkPassphrase, getAdminKeypair, signAndSubmit, isRpcAvailable } from "./stellar";
import { enqueue } from "./tx-queue";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.PROJECT_REGISTRY_CONTRACT_ID) {
  throw new Error("PROJECT_REGISTRY_CONTRACT_ID env var is required");
}
const REGISTRY_CONTRACT_ID = process.env.PROJECT_REGISTRY_CONTRACT_ID;

let cachedTotalProjects: number = 0;
let lastTotalFetch: number = 0;
const TOTAL_CACHE_TTL_MS = 300_000;

export class RpcDegradedError extends Error {
  readonly projectId: number;
  readonly creditQuality: number;
  readonly greenImpact: number;

  constructor(projectId: number, creditQuality: number, greenImpact: number, cause: string) {
    super(`RPC degraded for project ${projectId}: ${cause}`);
    this.name = "RpcDegradedError";
    this.projectId = projectId;
    this.creditQuality = creditQuality;
    this.greenImpact = greenImpact;
  }
}

export async function updateImpactScore(
  projectId: number,
  creditQuality: number,
  greenImpact: number
): Promise<string> {
  if (!isRpcAvailable()) {
    enqueue(projectId, creditQuality, greenImpact, "RPC unavailable");
    throw new RpcDegradedError(projectId, creditQuality, greenImpact, "RPC not available");
  }

  try {
    return await withRpcConnection(async (client) => {
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
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    enqueue(projectId, creditQuality, greenImpact, errorMsg);
    throw new RpcDegradedError(projectId, creditQuality, greenImpact, errorMsg);
  }
}

export async function getTotalProjects(): Promise<number> {
  const now = Date.now();
  if (cachedTotalProjects > 0 && now - lastTotalFetch < TOTAL_CACHE_TTL_MS) {
    return cachedTotalProjects;
  }

  if (!isRpcAvailable()) {
    if (cachedTotalProjects > 0) return cachedTotalProjects;
    return 1;
  }

  try {
    const total = await withRpcConnection(async (client) => {
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
    cachedTotalProjects = total;
    lastTotalFetch = now;
    return total;
  } catch (err) {
    if (cachedTotalProjects > 0) return cachedTotalProjects;
    throw err;
  }
}

export function clearProjectTotalCache(): void {
  cachedTotalProjects = 0;
  lastTotalFetch = 0;
}
