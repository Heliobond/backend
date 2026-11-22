export type ChainId = "stellar" | "ethereum" | "polygon";

export interface ChainConfig {
  id: ChainId;
  name: string;
  rpcUrl: string;
  nativeSymbol: string;
  enabled: boolean;
  contractAddress?: string;
}

export interface ChainTransaction {
  chain: ChainId;
  txHash: string;
  status: "pending" | "confirmed" | "failed";
  timestamp: number;
}

/**
 * Outcome of a single-chain submission attempt.
 *
 * `status` distinguishes real submissions from chains that have no
 * implementation yet. `txHash` is only populated when `status === "submitted"`;
 * it is never synthesized as a placeholder.
 */
export type ChainSubmissionStatus = "submitted" | "failed" | "not_implemented";

export interface ChainSubmissionResult {
  chain: ChainId;
  status: ChainSubmissionStatus;
  /** Real transaction hash, or an empty string when the update was not submitted. */
  txHash: string;
  /** Kept for backwards compatibility; true only for `status === "submitted"`. */
  success: boolean;
  error?: string;
}

export interface MultiChainScoreUpdate {
  projectId: number;
  creditQuality: number;
  greenImpact: number;
  chains: ChainId[];
  results: ChainSubmissionResult[];
}

export const EVM_NOT_IMPLEMENTED_ERROR =
  "not_implemented: EVM chain submission is not implemented; only Stellar is currently supported";

const DEFAULT_CHAINS: ChainConfig[] = [
  {
    id: "stellar",
    name: "Stellar",
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    nativeSymbol: "XLM",
    enabled: true,
  },
  {
    id: "ethereum",
    name: "Ethereum Mainnet",
    rpcUrl: process.env.ETH_RPC_URL ?? "",
    nativeSymbol: "ETH",
    enabled: Boolean(process.env.ETH_RPC_URL),
    contractAddress: process.env.ETH_CONTRACT_ADDRESS,
  },
  {
    id: "polygon",
    name: "Polygon",
    rpcUrl: process.env.POLYGON_RPC_URL ?? "",
    nativeSymbol: "MATIC",
    enabled: Boolean(process.env.POLYGON_RPC_URL),
    contractAddress: process.env.POLYGON_CONTRACT_ADDRESS,
  },
];

const chainRegistry = new Map<ChainId, ChainConfig>(
  DEFAULT_CHAINS.map((c) => [c.id, c]),
);

export function getChains(): ChainConfig[] {
  return Array.from(chainRegistry.values());
}

export function getEnabledChains(): ChainConfig[] {
  return Array.from(chainRegistry.values()).filter((c) => c.enabled);
}

export function getChain(id: ChainId): ChainConfig | undefined {
  return chainRegistry.get(id);
}

export function configureChain(id: ChainId, updates: Partial<Omit<ChainConfig, "id">>): boolean {
  const chain = chainRegistry.get(id);
  if (!chain) return false;
  Object.assign(chain, updates);
  return true;
}

export function selectChain(id: ChainId): ChainConfig | null {
  const chain = chainRegistry.get(id);
  if (!chain || !chain.enabled) return null;
  return chain;
}

export async function broadcastToChains(
  projectId: number,
  creditQuality: number,
  greenImpact: number,
  chainIds?: ChainId[],
): Promise<MultiChainScoreUpdate> {
  const targets = chainIds
    ? chainIds.map((id) => chainRegistry.get(id)).filter(Boolean) as ChainConfig[]
    : getEnabledChains();

  const results: MultiChainScoreUpdate["results"] = [];

  for (const chain of targets) {
    // Stellar is the only chain with a real submission path. EVM chains reply
    // with an explicit not_implemented status instead of a fabricated hash.
    if (chain.id !== "stellar") {
      results.push({
        chain: chain.id,
        status: "not_implemented",
        txHash: "",
        success: false,
        error: EVM_NOT_IMPLEMENTED_ERROR,
      });
      continue;
    }

    try {
      const txHash = await submitToChain(chain, projectId, creditQuality, greenImpact);
      results.push({ chain: chain.id, status: "submitted", txHash, success: true });
    } catch (err) {
      results.push({
        chain: chain.id,
        status: "failed",
        txHash: "",
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    projectId,
    creditQuality,
    greenImpact,
    chains: targets.map((c) => c.id),
    results,
  };
}

async function submitToChain(
  chain: ChainConfig,
  projectId: number,
  creditQuality: number,
  greenImpact: number,
): Promise<string> {
  // Stellar uses the existing Soroban/Stellar SDK path
  if (chain.id === "stellar") {
    const { updateImpactScore } = await import("./registry.js");
    return updateImpactScore(projectId, creditQuality, greenImpact);
  }

  // No EVM submission path exists. Refuse loudly rather than returning a
  // synthesized hash that consumers could mistake for an on-chain write.
  throw new Error(EVM_NOT_IMPLEMENTED_ERROR);
}
