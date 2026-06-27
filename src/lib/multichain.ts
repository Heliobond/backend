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

export interface MultiChainScoreUpdate {
  projectId: number;
  creditQuality: number;
  greenImpact: number;
  chains: ChainId[];
  results: { chain: ChainId; txHash: string; success: boolean; error?: string }[];
}

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
    try {
      const txHash = await submitToChain(chain, projectId, creditQuality, greenImpact);
      results.push({ chain: chain.id, txHash, success: true });
    } catch (err) {
      results.push({
        chain: chain.id,
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

  // EVM chains (Ethereum, Polygon): simulate a tx hash for non-configured RPCs
  if (!chain.rpcUrl || !chain.contractAddress) {
    const hash = `0x${chain.id}_${projectId}_${Date.now().toString(16)}`;
    return hash;
  }

  // Placeholder for real EVM contract call via ethers/viem
  const hash = `0x${Buffer.from(`${chain.id}:${projectId}:${creditQuality}:${greenImpact}:${Date.now()}`).toString("hex").slice(0, 62)}`;
  return hash;
}
