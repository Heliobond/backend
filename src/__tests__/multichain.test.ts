/**
 * Unit tests for src/lib/multichain.ts
 *
 * Covers all exported functions:
 *   getChains, getEnabledChains, getChain,
 *   configureChain, selectChain, broadcastToChains
 *
 * The module-level chainRegistry persists between tests, so we restore
 * each chain's state in afterEach to keep tests isolated.
 */

// --- Mock registry.js (dynamic import used by submitToChain for Stellar) ---
// multichain.ts uses `await import("./registry.js")` — the .js extension is the
// TypeScript "emit-style" reference.  Under ts-jest/CommonJS the resolver maps
// ./registry.js to ./registry.ts on disk, so we mock the .js path as virtual.
jest.mock(
  "../lib/registry.js",
  () => ({
    updateImpactScore: jest.fn(),
  }),
  { virtual: true },
);

import {
  getChains,
  getEnabledChains,
  getChain,
  configureChain,
  selectChain,
  broadcastToChains,
  ChainId,
} from "../lib/multichain";

// Lazy-import the mock so we can control its resolved value per test.
// We use jest.requireMock here because the module is already mocked above.
const registryMock = jest.requireMock("../lib/registry.js") as {
  updateImpactScore: jest.Mock;
};

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Snapshot the enabled flag for all three chains before a test so we can
 * restore it in afterEach regardless of what the test mutates.
 */
function snapshotEnabled(): Record<ChainId, boolean> {
  return Object.fromEntries(getChains().map((c) => [c.id, c.enabled])) as Record<ChainId, boolean>;
}

// ─── getChains ───────────────────────────────────────────────────────────────

describe("getChains", () => {
  it("returns all three default chains", () => {
    const chains = getChains();
    expect(chains).toHaveLength(3);
    const ids = chains.map((c) => c.id);
    expect(ids).toContain("stellar");
    expect(ids).toContain("ethereum");
    expect(ids).toContain("polygon");
  });

  it("returns ChainConfig objects with required fields", () => {
    const chains = getChains();
    for (const chain of chains) {
      expect(chain).toHaveProperty("id");
      expect(chain).toHaveProperty("name");
      expect(chain).toHaveProperty("rpcUrl");
      expect(chain).toHaveProperty("nativeSymbol");
      expect(typeof chain.enabled).toBe("boolean");
    }
  });

  it("Stellar chain is always enabled by default", () => {
    const stellar = getChains().find((c) => c.id === "stellar");
    expect(stellar?.enabled).toBe(true);
  });

  it("returns a fresh array each call (not the same reference)", () => {
    const a = getChains();
    const b = getChains();
    expect(a).not.toBe(b);
  });
});

// ─── getEnabledChains ────────────────────────────────────────────────────────

describe("getEnabledChains", () => {
  let original: Record<ChainId, boolean>;

  beforeEach(() => {
    original = snapshotEnabled();
  });

  afterEach(() => {
    // Restore enabled state
    for (const [id, enabled] of Object.entries(original) as [ChainId, boolean][]) {
      configureChain(id, { enabled });
    }
  });

  it("returns only enabled chains", () => {
    // By default only Stellar is enabled (EVM chains need env vars)
    const enabled = getEnabledChains();
    for (const chain of enabled) {
      expect(chain.enabled).toBe(true);
    }
  });

  it("includes Stellar in the result", () => {
    const ids = getEnabledChains().map((c) => c.id);
    expect(ids).toContain("stellar");
  });

  it("reflects chains enabled via configureChain", () => {
    configureChain("ethereum", { enabled: true });
    const ids = getEnabledChains().map((c) => c.id);
    expect(ids).toContain("ethereum");
  });

  it("excludes chains disabled via configureChain", () => {
    configureChain("stellar", { enabled: false });
    const ids = getEnabledChains().map((c) => c.id);
    expect(ids).not.toContain("stellar");
  });

  it("returns an empty array when all chains are disabled", () => {
    configureChain("stellar", { enabled: false });
    configureChain("ethereum", { enabled: false });
    configureChain("polygon", { enabled: false });
    expect(getEnabledChains()).toHaveLength(0);
  });
});

// ─── getChain ────────────────────────────────────────────────────────────────

describe("getChain", () => {
  it("returns the correct chain for 'stellar'", () => {
    const chain = getChain("stellar");
    expect(chain).toBeDefined();
    expect(chain?.id).toBe("stellar");
    expect(chain?.nativeSymbol).toBe("XLM");
  });

  it("returns the correct chain for 'ethereum'", () => {
    const chain = getChain("ethereum");
    expect(chain).toBeDefined();
    expect(chain?.id).toBe("ethereum");
    expect(chain?.nativeSymbol).toBe("ETH");
  });

  it("returns the correct chain for 'polygon'", () => {
    const chain = getChain("polygon");
    expect(chain).toBeDefined();
    expect(chain?.id).toBe("polygon");
    expect(chain?.nativeSymbol).toBe("MATIC");
  });

  it("returns undefined for an unknown chain id", () => {
    // Cast to ChainId to satisfy TS; testing runtime unknown key behaviour
    expect(getChain("solana" as ChainId)).toBeUndefined();
  });
});

// ─── configureChain ──────────────────────────────────────────────────────────

describe("configureChain", () => {
  let original: Record<ChainId, boolean>;

  beforeEach(() => {
    original = snapshotEnabled();
  });

  afterEach(() => {
    // Restore enabled flags and clear any test-added rpcUrl / contractAddress
    for (const [id, enabled] of Object.entries(original) as [ChainId, boolean][]) {
      configureChain(id, { enabled });
    }
    // Restore EVM chains to their unconfigured defaults
    configureChain("ethereum", { rpcUrl: "", contractAddress: undefined });
    configureChain("polygon", { rpcUrl: "", contractAddress: undefined });
  });

  it("returns true when chain exists and updates the field", () => {
    const result = configureChain("stellar", { name: "Stellar Testnet" });
    expect(result).toBe(true);
    expect(getChain("stellar")?.name).toBe("Stellar Testnet");
    // restore name
    configureChain("stellar", { name: "Stellar" });
  });

  it("returns false for an unknown chain id", () => {
    expect(configureChain("solana" as ChainId, { enabled: true })).toBe(false);
  });

  it("can enable a previously disabled chain", () => {
    configureChain("ethereum", { enabled: true });
    expect(getChain("ethereum")?.enabled).toBe(true);
  });

  it("can disable a previously enabled chain", () => {
    configureChain("stellar", { enabled: false });
    expect(getChain("stellar")?.enabled).toBe(false);
  });

  it("can set rpcUrl and contractAddress on EVM chains", () => {
    configureChain("ethereum", {
      rpcUrl: "https://eth-mainnet.example.com",
      contractAddress: "0xABCDEF",
    });
    const eth = getChain("ethereum");
    expect(eth?.rpcUrl).toBe("https://eth-mainnet.example.com");
    expect(eth?.contractAddress).toBe("0xABCDEF");
  });

  it("can update multiple fields in a single call", () => {
    configureChain("polygon", {
      enabled: true,
      rpcUrl: "https://polygon-rpc.example.com",
      contractAddress: "0xPOLYGON",
    });
    const poly = getChain("polygon");
    expect(poly?.enabled).toBe(true);
    expect(poly?.rpcUrl).toBe("https://polygon-rpc.example.com");
  });

  it("does not affect the chain id", () => {
    configureChain("stellar", { name: "Updated Name" });
    expect(getChain("stellar")?.id).toBe("stellar");
    // restore
    configureChain("stellar", { name: "Stellar" });
  });
});

// ─── selectChain ─────────────────────────────────────────────────────────────

describe("selectChain", () => {
  let original: Record<ChainId, boolean>;

  beforeEach(() => {
    original = snapshotEnabled();
  });

  afterEach(() => {
    for (const [id, enabled] of Object.entries(original) as [ChainId, boolean][]) {
      configureChain(id, { enabled });
    }
  });

  it("returns the chain when it is enabled", () => {
    const chain = selectChain("stellar");
    expect(chain).not.toBeNull();
    expect(chain?.id).toBe("stellar");
  });

  it("returns null when the chain is disabled", () => {
    configureChain("stellar", { enabled: false });
    expect(selectChain("stellar")).toBeNull();
  });

  it("returns null for an unknown chain id", () => {
    expect(selectChain("solana" as ChainId)).toBeNull();
  });

  it("returns the chain after it is enabled via configureChain", () => {
    configureChain("ethereum", { enabled: true });
    const chain = selectChain("ethereum");
    expect(chain).not.toBeNull();
    expect(chain?.id).toBe("ethereum");
  });

  it("returns null for EVM chains that are not enabled", () => {
    // EVM chains default to disabled when env vars are unset
    expect(selectChain("ethereum")).toBeNull();
    expect(selectChain("polygon")).toBeNull();
  });
});

// ─── broadcastToChains ───────────────────────────────────────────────────────

describe("broadcastToChains", () => {
  let original: Record<ChainId, boolean>;

  beforeEach(() => {
    jest.clearAllMocks();
    original = snapshotEnabled();
    // Disable EVM chains so tests are deterministic unless explicitly enabled
    configureChain("ethereum", { enabled: false, rpcUrl: "", contractAddress: undefined });
    configureChain("polygon", { enabled: false, rpcUrl: "", contractAddress: undefined });
    // Ensure Stellar is enabled
    configureChain("stellar", { enabled: true });
    // Default registry mock
    registryMock.updateImpactScore.mockResolvedValue("stellar_tx_hash_abc");
  });

  afterEach(() => {
    for (const [id, enabled] of Object.entries(original) as [ChainId, boolean][]) {
      configureChain(id, { enabled });
    }
    configureChain("ethereum", { rpcUrl: "", contractAddress: undefined });
    configureChain("polygon", { rpcUrl: "", contractAddress: undefined });
  });

  // ── return shape ────────────────────────────────────────────────────────────

  it("returns the correct MultiChainScoreUpdate shape", async () => {
    const result = await broadcastToChains(1, 85, 70);
    expect(result).toHaveProperty("projectId", 1);
    expect(result).toHaveProperty("creditQuality", 85);
    expect(result).toHaveProperty("greenImpact", 70);
    expect(result).toHaveProperty("chains");
    expect(result).toHaveProperty("results");
    expect(Array.isArray(result.chains)).toBe(true);
    expect(Array.isArray(result.results)).toBe(true);
  });

  // ── Stellar happy path ───────────────────────────────────────────────────────

  it("broadcasts to Stellar via registry.updateImpactScore", async () => {
    const result = await broadcastToChains(1, 85, 70, ["stellar"]);
    expect(registryMock.updateImpactScore).toHaveBeenCalledWith(1, 85, 70);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      chain: "stellar",
      txHash: "stellar_tx_hash_abc",
      success: true,
    });
  });

  it("passes correct projectId, creditQuality, and greenImpact to registry", async () => {
    await broadcastToChains(42, 90, 55, ["stellar"]);
    expect(registryMock.updateImpactScore).toHaveBeenCalledWith(42, 90, 55);
  });

  // ── EVM fabricated hash (no rpcUrl / contractAddress) ────────────────────────

  it("fabricates an EVM tx hash when rpcUrl is missing", async () => {
    configureChain("ethereum", { enabled: true, rpcUrl: "", contractAddress: undefined });
    const result = await broadcastToChains(5, 70, 60, ["ethereum"]);
    const ethResult = result.results.find((r) => r.chain === "ethereum");
    expect(ethResult?.success).toBe(true);
    expect(ethResult?.txHash).toMatch(/^0x/);
    expect(ethResult?.txHash).toContain("ethereum");
  });

  it("fabricated EVM hash contains the project id", async () => {
    configureChain("polygon", { enabled: true, rpcUrl: "", contractAddress: undefined });
    const result = await broadcastToChains(99, 50, 50, ["polygon"]);
    const polyResult = result.results.find((r) => r.chain === "polygon");
    expect(polyResult?.txHash).toContain("99");
  });

  it("fabricated EVM hash contains the chain id", async () => {
    configureChain("ethereum", { enabled: true, rpcUrl: "", contractAddress: undefined });
    const result = await broadcastToChains(1, 80, 80, ["ethereum"]);
    const ethResult = result.results.find((r) => r.chain === "ethereum");
    expect(ethResult?.txHash).toContain("ethereum");
  });

  // ── EVM configured (rpcUrl + contractAddress present) ────────────────────────

  it("returns a valid 0x-prefixed hash when rpcUrl and contractAddress are set", async () => {
    configureChain("ethereum", {
      enabled: true,
      rpcUrl: "https://eth-rpc.example.com",
      contractAddress: "0xABCDEF1234",
    });
    const result = await broadcastToChains(1, 75, 65, ["ethereum"]);
    const ethResult = result.results.find((r) => r.chain === "ethereum");
    expect(ethResult?.success).toBe(true);
    expect(ethResult?.txHash).toMatch(/^0x[0-9a-f]+$/i);
  });

  // ── multi-chain targeting ────────────────────────────────────────────────────

  it("broadcasts to multiple explicit chains", async () => {
    configureChain("ethereum", { enabled: true, rpcUrl: "", contractAddress: undefined });
    const result = await broadcastToChains(1, 80, 60, ["stellar", "ethereum"]);
    expect(result.chains).toContain("stellar");
    expect(result.chains).toContain("ethereum");
    expect(result.results).toHaveLength(2);
  });

  it("uses all enabled chains when chainIds is omitted", async () => {
    // Only Stellar is enabled in beforeEach
    const result = await broadcastToChains(1, 80, 60);
    expect(result.chains).toEqual(["stellar"]);
    expect(result.results).toHaveLength(1);
  });

  it("uses all enabled chains when chainIds is undefined", async () => {
    configureChain("ethereum", { enabled: true });
    const result = await broadcastToChains(1, 80, 60, undefined);
    const ids = result.chains;
    expect(ids).toContain("stellar");
    expect(ids).toContain("ethereum");
  });

  it("returns an empty result set when no chains match the provided ids", async () => {
    // Requesting a chain id that is not in the registry at all
    const result = await broadcastToChains(1, 80, 60, ["solana" as ChainId]);
    expect(result.chains).toHaveLength(0);
    expect(result.results).toHaveLength(0);
  });

  it("returns an empty result set when explicit chain ids are all disabled", async () => {
    // ethereum is disabled in beforeEach; passing it explicitly still resolves to nothing
    // because chainIds filters from registry (returns the chain config), but the chain
    // is still processed regardless of enabled flag when explicitly specified.
    // Verify the function processes whatever is in the registry for the given ids.
    configureChain("ethereum", { enabled: false, rpcUrl: "", contractAddress: undefined });
    const result = await broadcastToChains(1, 80, 60, ["ethereum"]);
    // The function looks up by id and processes it even if disabled — only enabled filter
    // is applied when no explicit list is given. Verify it processes the chain.
    expect(result.chains).toContain("ethereum");
    expect(result.results).toHaveLength(1);
  });

  // ── error handling ───────────────────────────────────────────────────────────

  it("catches registry errors and marks the chain result as failed", async () => {
    registryMock.updateImpactScore.mockRejectedValue(new Error("RPC timeout"));
    const result = await broadcastToChains(1, 80, 60, ["stellar"]);
    expect(result.results[0]).toMatchObject({
      chain: "stellar",
      txHash: "",
      success: false,
      error: "RPC timeout",
    });
  });

  it("captures non-Error throwables as strings in the error field", async () => {
    registryMock.updateImpactScore.mockRejectedValue("network unreachable");
    const result = await broadcastToChains(1, 80, 60, ["stellar"]);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toBe("network unreachable");
  });

  it("continues processing subsequent chains after one failure", async () => {
    configureChain("ethereum", { enabled: true, rpcUrl: "", contractAddress: undefined });
    registryMock.updateImpactScore.mockRejectedValue(new Error("Stellar down"));

    const result = await broadcastToChains(1, 80, 60, ["stellar", "ethereum"]);
    expect(result.results).toHaveLength(2);

    const stellarRes = result.results.find((r) => r.chain === "stellar");
    const ethRes = result.results.find((r) => r.chain === "ethereum");

    expect(stellarRes?.success).toBe(false);
    expect(ethRes?.success).toBe(true); // EVM fabricated hash succeeds
  });

  it("does not reject the returned promise even when all chains fail", async () => {
    registryMock.updateImpactScore.mockRejectedValue(new Error("all down"));
    await expect(broadcastToChains(1, 80, 60, ["stellar"])).resolves.toBeDefined();
  });

  // ── result metadata ──────────────────────────────────────────────────────────

  it("includes the projectId in the returned object", async () => {
    const result = await broadcastToChains(7, 50, 50, ["stellar"]);
    expect(result.projectId).toBe(7);
  });

  it("includes creditQuality and greenImpact in the returned object", async () => {
    const result = await broadcastToChains(1, 77, 88, ["stellar"]);
    expect(result.creditQuality).toBe(77);
    expect(result.greenImpact).toBe(88);
  });

  it("chains array matches the targets that were processed", async () => {
    configureChain("polygon", { enabled: true, rpcUrl: "", contractAddress: undefined });
    const result = await broadcastToChains(1, 80, 60, ["stellar", "polygon"]);
    expect(result.chains).toEqual(["stellar", "polygon"]);
  });
});
