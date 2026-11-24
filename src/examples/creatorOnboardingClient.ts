/**
 * Client Example: Preparation, signing, and submission pipeline for unsigned onboarding transactions (#1005).
 *
 * Demonstrates taking an unsigned transaction returned by the Heliobond backend through
 * every required preparation, signing, and submission step on Soroban:
 *
 *   1. Fetch unsigned XDR & preparation contract from backend
 *   2. Parse XDR into a Stellar Transaction
 *   3. Simulate transaction via Soroban RPC (simulateTransaction)
 *   4. Assemble transaction resources, fees, and auth footprint (assembleTransaction)
 *   5. Sign assembled transaction with source account Keypair
 *   6. Submit assembled & signed transaction to network (sendTransaction)
 */
import { Keypair, Transaction, TransactionBuilder, rpc, Networks } from "@stellar/stellar-sdk";
import {
  OnboardingTxPreparationContract,
  executeClientOnboardingTransaction,
  ClientExecutionResult,
} from "../lib/creatorOnboarding";

export interface OnboardingApiResponse {
  application_id: string;
  project_id: number | null;
  metadata_hash: string;
  metadata_uri: string;
  /** Exact decimal u64 (unix seconds). */
  maturity_date: string;
  unsigned_xdr: string;
  signed: boolean;
  prepared: boolean;
  preparation: OnboardingTxPreparationContract;
}

export interface ClientWorkflowOptions {
  apiBaseUrl: string;
  applicationId: string;
  creatorKeypair: Keypair;
  rpcUrl: string;
  networkPassphrase?: string;
  fetchFn?: typeof fetch;
}

/**
 * Executes the complete creator onboarding transaction lifecycle:
 * Fetch -> Parse -> Simulate -> Assemble -> Sign -> Submit.
 */
export async function executeCreatorOnboardingWorkflow(
  opts: ClientWorkflowOptions,
): Promise<ClientExecutionResult> {
  const fetchClient = opts.fetchFn ?? fetch;
  const networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;

  // 1. Fetch unsigned XDR and preparation requirements from backend
  const url = `${opts.apiBaseUrl}/v1/creators/applications/${opts.applicationId}/create-project-tx?sequence=0`;
  const res = await fetchClient(url, {
    method: "GET",
    headers: {
      "x-wallet-address": opts.creatorKeypair.publicKey(),
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch create-project-tx: HTTP ${res.status}`);
  }

  const data: OnboardingApiResponse = (await res.json()) as OnboardingApiResponse;

  // 2. Verify preparation requirements published by backend
  if (!data.unsigned_xdr) {
    throw new Error("API response missing unsigned_xdr");
  }
  if (!data.preparation || !data.preparation.simulation_required) {
    throw new Error("API response missing explicit preparation requirements");
  }

  // 3. Connect to Soroban RPC
  const server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith("http://") });

  // 4. Run client preparation, signing, and submission pipeline
  return executeClientOnboardingTransaction({
    unsignedXdr: data.unsigned_xdr,
    signerKeypair: opts.creatorKeypair,
    rpcServer: server,
  });
}
