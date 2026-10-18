/**
 * Exhaustive test suite verifying EVM transaction hash sanitization and
 * elimination of synthesized/fabricated hashes in cross-chain score submission.
 */

jest.mock(
  "../lib/registry.js",
  () => ({
    updateImpactScore: jest.fn(),
  }),
  { virtual: true },
);

import { getChains, configureChain, broadcastToChains, ChainId } from "../lib/multichain";

const registryMock = jest.requireMock("../lib/registry.js") as {
  updateImpactScore: jest.Mock;
};

function snapshotState(): Record<
  ChainId,
  { enabled: boolean; rpcUrl: string; contractAddress?: string }
> {
  return Object.fromEntries(
    getChains().map((c) => [
      c.id,
      { enabled: c.enabled, rpcUrl: c.rpcUrl, contractAddress: c.contractAddress },
    ]),
  ) as Record<ChainId, { enabled: boolean; rpcUrl: string; contractAddress?: string }>;
}

describe("Cross-Chain Submission Integrity & Fake Hash Elimination", () => {
  let originalState: Record<
    ChainId,
    { enabled: boolean; rpcUrl: string; contractAddress?: string }
  >;

  beforeEach(() => {
    originalState = snapshotState();
    jest.clearAllMocks();
    registryMock.updateImpactScore.mockResolvedValue("stellar_tx_hash_valid_0x123");

    // Standard baseline: Stellar enabled, EVM chains disabled by default
    configureChain("stellar", { enabled: true });
    configureChain("ethereum", { enabled: false, rpcUrl: "", contractAddress: undefined });
    configureChain("polygon", { enabled: false, rpcUrl: "", contractAddress: undefined });
  });

  afterEach(() => {
    for (const [id, cfg] of Object.entries(originalState) as [ChainId, any][]) {
      configureChain(id, cfg);
    }
  });

  // =========================================================================
  // Project ID & Score Boundary Tests
  // =========================================================================
  describe("Project ID & Score Boundaries", () => {
    const projectIds = [0, 1, 2, 10, 42, 999, 10000, 999999];
    it.each(projectIds)(
      "ensures EVM never returns fabricated hash for projectId=%i",
      async (pid) => {
        configureChain("ethereum", {
          enabled: true,
          rpcUrl: "https://mainnet.infura.io/v3/fake",
          contractAddress: "0x1234567890123456789012345678901234567890",
        });

        const res = await broadcastToChains(pid, 85, 90, ["ethereum"]);
        expect(res.results).toHaveLength(1);
        const eth = res.results[0];
        expect(eth.chain).toBe("ethereum");
        expect(eth.success).toBe(false);
        expect(eth.txHash).toBe("");
        expect(eth.txHash).not.toContain(String(pid));
        expect(eth.txHash).not.toMatch(/^0x/);
        expect(eth.error).toContain("EVM chain submission is not implemented");
      },
    );

    const scorePairs = [
      { cq: 0, gi: 0 },
      { cq: 0, gi: 100 },
      { cq: 100, gi: 0 },
      { cq: 100, gi: 100 },
      { cq: 50, gi: 50 },
      { cq: 1, gi: 99 },
      { cq: 99, gi: 1 },
    ];
    it.each(scorePairs)(
      "preserves score accuracy without emitting fake hash for CQ=$cq, GI=$gi",
      async ({ cq, gi }) => {
        configureChain("polygon", {
          enabled: true,
          rpcUrl: "https://polygon-rpc.com",
          contractAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        });

        const res = await broadcastToChains(1, cq, gi, ["polygon"]);
        expect(res.creditQuality).toBe(cq);
        expect(res.greenImpact).toBe(gi);
        const poly = res.results[0];
        expect(poly.success).toBe(false);
        expect(poly.txHash).toBe("");
        expect(poly.error).toContain("EVM chain submission is not implemented for Polygon");
      },
    );
  });

  // =========================================================================
  // Combinatorial Chain Targets & Configuration Matrix
  // =========================================================================
  describe("Combinatorial Chain Targets & Configurations", () => {
    const chainCombinations: {
      targets: ChainId[];
      expectedCount: number;
      stellarExpected: boolean;
    }[] = [
      { targets: ["stellar"], expectedCount: 1, stellarExpected: true },
      { targets: ["ethereum"], expectedCount: 1, stellarExpected: false },
      { targets: ["polygon"], expectedCount: 1, stellarExpected: false },
      { targets: ["stellar", "ethereum"], expectedCount: 2, stellarExpected: true },
      { targets: ["stellar", "polygon"], expectedCount: 2, stellarExpected: true },
      { targets: ["ethereum", "polygon"], expectedCount: 2, stellarExpected: false },
      { targets: ["stellar", "ethereum", "polygon"], expectedCount: 3, stellarExpected: true },
    ];

    it.each(chainCombinations)(
      "evaluates target combination $targets (count=$expectedCount)",
      async ({ targets, expectedCount, stellarExpected }) => {
        configureChain("ethereum", {
          enabled: true,
          rpcUrl: "https://eth.rpc",
          contractAddress: "0x1111",
        });
        configureChain("polygon", {
          enabled: true,
          rpcUrl: "https://poly.rpc",
          contractAddress: "0x2222",
        });

        const res = await broadcastToChains(1, 80, 80, targets);
        expect(res.results).toHaveLength(expectedCount);

        for (const item of res.results) {
          if (item.chain === "stellar") {
            expect(item.success).toBe(true);
            expect(item.txHash).toBe("stellar_tx_hash_valid_0x123");
          } else {
            // EVM chains must ALWAYS be marked as failed with zero hash
            expect(item.success).toBe(false);
            expect(item.txHash).toBe("");
            expect(item.error).toBeDefined();
          }
        }

        if (stellarExpected) {
          expect(registryMock.updateImpactScore).toHaveBeenCalled();
        } else {
          expect(registryMock.updateImpactScore).not.toHaveBeenCalled();
        }
      },
    );

    const evmConfigs = [
      { desc: "empty rpc, empty contract", rpc: "", contract: undefined, expectMissing: true },
      {
        desc: "valid rpc, empty contract",
        rpc: "https://rpc.eth",
        contract: undefined,
        expectMissing: true,
      },
      { desc: "empty rpc, valid contract", rpc: "", contract: "0x123", expectMissing: true },
      {
        desc: "whitespace rpc, empty contract",
        rpc: "   ",
        contract: undefined,
        expectMissing: true,
      },
      {
        desc: "fully configured rpc and contract",
        rpc: "https://rpc.eth",
        contract: "0x123",
        expectMissing: false,
      },
    ];

    it.each(evmConfigs)(
      "verifies Ethereum with $desc reports correct error and no fake hash",
      async ({ rpc, contract, expectMissing }) => {
        configureChain("ethereum", { enabled: true, rpcUrl: rpc, contractAddress: contract });
        const res = await broadcastToChains(10, 75, 75, ["ethereum"]);
        const eth = res.results[0];

        expect(eth.success).toBe(false);
        expect(eth.txHash).toBe("");
        if (expectMissing) {
          expect(eth.error).toContain("missing rpcUrl or contractAddress");
        } else {
          expect(eth.error).toContain("EVM chain submission is not implemented");
        }
      },
    );

    it.each(evmConfigs)(
      "verifies Polygon with $desc reports correct error and no fake hash",
      async ({ rpc, contract, expectMissing }) => {
        configureChain("polygon", { enabled: true, rpcUrl: rpc, contractAddress: contract });
        const res = await broadcastToChains(20, 85, 85, ["polygon"]);
        const poly = res.results[0];

        expect(poly.success).toBe(false);
        expect(poly.txHash).toBe("");
        if (expectMissing) {
          expect(poly.error).toContain("missing rpcUrl or contractAddress");
        } else {
          expect(poly.error).toContain("EVM chain submission is not implemented");
        }
      },
    );
  });

  // =========================================================================
  // Unconfigured vs Configured Permutations (Parametric Matrix)
  // =========================================================================
  describe("Parametric Configuration Permutations", () => {
    const matrix: { ethConfigured: boolean; polyConfigured: boolean }[] = [];
    for (const ethConfigured of [true, false]) {
      for (const polyConfigured of [true, false]) {
        matrix.push({ ethConfigured, polyConfigured });
      }
    }

    it.each(matrix)(
      "asserts zero fake hashes when ethConfigured=$ethConfigured, polyConfigured=$polyConfigured",
      async ({ ethConfigured, polyConfigured }) => {
        configureChain("ethereum", {
          enabled: true,
          rpcUrl: ethConfigured ? "https://eth.rpc" : "",
          contractAddress: ethConfigured ? "0x123" : undefined,
        });
        configureChain("polygon", {
          enabled: true,
          rpcUrl: polyConfigured ? "https://poly.rpc" : "",
          contractAddress: polyConfigured ? "0x456" : undefined,
        });

        const res = await broadcastToChains(1, 80, 70, ["ethereum", "polygon"]);
        expect(res.results).toHaveLength(2);

        for (const r of res.results) {
          expect(r.success).toBe(false);
          expect(r.txHash).toBe("");
          expect(r.txHash).not.toMatch(/^0x[a-f0-9_]+$/i);
        }
      },
    );

    const chainNameCases = [
      { id: "ethereum" as ChainId, name: "Ethereum Mainnet" },
      { id: "polygon" as ChainId, name: "Polygon" },
    ];
    it.each(chainNameCases)(
      "reports accurate chain name in error message for $id",
      async ({ id, name }) => {
        configureChain(id, { enabled: true, rpcUrl: "https://rpc", contractAddress: "0x1" });
        const res = await broadcastToChains(1, 80, 80, [id]);
        expect(res.results[0].error).toBe(`EVM chain submission is not implemented for ${name}`);
      },
    );
  });

  // =========================================================================
  // Negative Controls & Isolation
  // =========================================================================
  describe("Negative Controls & Isolation", () => {
    it("proves that Stellar succeeds even when all EVM chains fail with not-implemented errors", async () => {
      configureChain("ethereum", { enabled: true, rpcUrl: "https://eth", contractAddress: "0x1" });
      configureChain("polygon", { enabled: true, rpcUrl: "https://poly", contractAddress: "0x2" });

      const res = await broadcastToChains(100, 95, 95, ["stellar", "ethereum", "polygon"]);
      const stellar = res.results.find((r) => r.chain === "stellar");
      const eth = res.results.find((r) => r.chain === "ethereum");
      const poly = res.results.find((r) => r.chain === "polygon");

      expect(stellar?.success).toBe(true);
      expect(stellar?.txHash).toBe("stellar_tx_hash_valid_0x123");

      expect(eth?.success).toBe(false);
      expect(eth?.txHash).toBe("");

      expect(poly?.success).toBe(false);
      expect(poly?.txHash).toBe("");
    });

    it("proves that EVM failures do not contaminate Stellar result with error strings", async () => {
      configureChain("ethereum", { enabled: true, rpcUrl: "", contractAddress: undefined });
      const res = await broadcastToChains(1, 80, 80, ["stellar", "ethereum"]);
      const stellar = res.results.find((r) => r.chain === "stellar");

      expect(stellar?.error).toBeUndefined();
      expect(stellar?.success).toBe(true);
    });

    it("handles unknown chain ids without crashing or returning fake hashes", async () => {
      const res = await broadcastToChains(1, 80, 80, ["solana" as ChainId, "arbitrum" as ChainId]);
      expect(res.chains).toEqual([]);
      expect(res.results).toEqual([]);
    });

    it("does not mutate default chains array on broadcast", async () => {
      const before = getChains();
      await broadcastToChains(1, 80, 80);
      const after = getChains();
      expect(before.length).toBe(after.length);
      expect(before.map((c) => c.id)).toEqual(after.map((c) => c.id));
    });
  });

  // =========================================================================
  // Concurrency & Stress Testing
  // =========================================================================
  describe("Concurrency & Stress Testing", () => {
    it("handles 50 concurrent broadcasts across all chains without emitting any fake hash", async () => {
      configureChain("ethereum", { enabled: true, rpcUrl: "https://eth", contractAddress: "0x1" });
      configureChain("polygon", { enabled: true, rpcUrl: "", contractAddress: undefined });

      const tasks = Array.from({ length: 50 }, (_, i) =>
        broadcastToChains(i + 1, 80, 85, ["stellar", "ethereum", "polygon"]),
      );

      const allResults = await Promise.all(tasks);
      expect(allResults).toHaveLength(50);

      for (let i = 0; i < 50; i++) {
        const item = allResults[i];
        expect(item.projectId).toBe(i + 1);

        const stellar = item.results.find((r) => r.chain === "stellar");
        const eth = item.results.find((r) => r.chain === "ethereum");
        const poly = item.results.find((r) => r.chain === "polygon");

        expect(stellar?.success).toBe(true);
        expect(stellar?.txHash).toBe("stellar_tx_hash_valid_0x123");

        expect(eth?.success).toBe(false);
        expect(eth?.txHash).toBe("");

        expect(poly?.success).toBe(false);
        expect(poly?.txHash).toBe("");
      }
    });

    const errorTypes = [
      { err: new Error("Network timeout"), expected: "Network timeout" },
      { err: "Plain string failure", expected: "Plain string failure" },
      { err: 404, expected: "404" },
      { err: { custom: "error object" }, expected: "[object Object]" },
    ];
    it.each(errorTypes)(
      "captures throwable $err as string in error field",
      async ({ err, expected }) => {
        registryMock.updateImpactScore.mockRejectedValue(err);
        const res = await broadcastToChains(1, 80, 80, ["stellar"]);
        expect(res.results[0].success).toBe(false);
        expect(res.results[0].error).toBe(expected);
        expect(res.results[0].txHash).toBe("");
      },
    );

    const stellarHashes = [
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333333333333333333333333333",
      "0x4444444444444444444444444444444444444444444444444444444444444444",
      "0x5555555555555555555555555555555555555555555555555555555555555555",
      "0x6666666666666666666666666666666666666666666666666666666666666666",
      "0x7777777777777777777777777777777777777777777777777777777777777777",
      "0x8888888888888888888888888888888888888888888888888888888888888888",
      "0x9999999999999999999999999999999999999999999999999999999999999999",
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ];
    it.each(stellarHashes)(
      "preserves authentic Stellar txHash=%s without leaking to EVM results",
      async (stellarHash) => {
        registryMock.updateImpactScore.mockResolvedValue(stellarHash);
        configureChain("ethereum", {
          enabled: true,
          rpcUrl: "https://eth",
          contractAddress: "0x1",
        });
        configureChain("polygon", {
          enabled: true,
          rpcUrl: "https://poly",
          contractAddress: "0x2",
        });

        const res = await broadcastToChains(1, 80, 80, ["stellar", "ethereum", "polygon"]);
        const stellar = res.results.find((r) => r.chain === "stellar");
        const eth = res.results.find((r) => r.chain === "ethereum");
        const poly = res.results.find((r) => r.chain === "polygon");

        expect(stellar?.success).toBe(true);
        expect(stellar?.txHash).toBe(stellarHash);

        expect(eth?.success).toBe(false);
        expect(eth?.txHash).toBe("");

        expect(poly?.success).toBe(false);
        expect(poly?.txHash).toBe("");
      },
    );

    const enabledCombinations = [
      { stellar: false, eth: false, poly: false, expectedChains: [] },
      { stellar: true, eth: false, poly: false, expectedChains: ["stellar"] },
      { stellar: false, eth: true, poly: false, expectedChains: ["ethereum"] },
      { stellar: false, eth: false, poly: true, expectedChains: ["polygon"] },
      { stellar: true, eth: true, poly: false, expectedChains: ["stellar", "ethereum"] },
      { stellar: true, eth: false, poly: true, expectedChains: ["stellar", "polygon"] },
      { stellar: false, eth: true, poly: true, expectedChains: ["ethereum", "polygon"] },
      { stellar: true, eth: true, poly: true, expectedChains: ["stellar", "ethereum", "polygon"] },
    ];
    it.each(enabledCombinations)(
      "default broadcast (no explicit chainIds) resolves enabled chains correctly: s=$stellar, e=$eth, p=$poly",
      async ({ stellar, eth, poly, expectedChains }) => {
        configureChain("stellar", { enabled: stellar });
        configureChain("ethereum", { enabled: eth, rpcUrl: "https://eth", contractAddress: "0x1" });
        configureChain("polygon", {
          enabled: poly,
          rpcUrl: "https://poly",
          contractAddress: "0x2",
        });

        const res = await broadcastToChains(5, 70, 75);
        expect(res.chains).toEqual(expectedChains);
        expect(res.results).toHaveLength(expectedChains.length);

        for (const item of res.results) {
          if (item.chain === "stellar") {
            expect(item.success).toBe(true);
            expect(item.txHash).toBe("stellar_tx_hash_valid_0x123");
          } else {
            expect(item.success).toBe(false);
            expect(item.txHash).toBe("");
          }
        }
      },
    );

    const projectMatrix = [
      { id: 101, cq: 80, gi: 90 },
      { id: 102, cq: 81, gi: 91 },
      { id: 103, cq: 82, gi: 92 },
      { id: 104, cq: 83, gi: 93 },
      { id: 105, cq: 84, gi: 94 },
      { id: 106, cq: 85, gi: 95 },
      { id: 107, cq: 86, gi: 96 },
      { id: 108, cq: 87, gi: 97 },
      { id: 109, cq: 88, gi: 98 },
      { id: 110, cq: 89, gi: 99 },
      { id: 111, cq: 90, gi: 100 },
      { id: 112, cq: 10, gi: 20 },
      { id: 113, cq: 30, gi: 40 },
      { id: 114, cq: 50, gi: 60 },
      { id: 115, cq: 70, gi: 80 },
    ];
    it.each(projectMatrix)(
      "asserts EVM chains never leak project metadata or synthetic hashes for projectId=$id",
      async ({ id, cq, gi }) => {
        configureChain("ethereum", {
          enabled: true,
          rpcUrl: "https://eth.rpc",
          contractAddress: "0x1",
        });
        configureChain("polygon", {
          enabled: true,
          rpcUrl: "https://poly.rpc",
          contractAddress: "0x2",
        });

        const res = await broadcastToChains(id, cq, gi, ["ethereum", "polygon"]);
        expect(res.projectId).toBe(id);
        expect(res.creditQuality).toBe(cq);
        expect(res.greenImpact).toBe(gi);

        for (const r of res.results) {
          expect(r.success).toBe(false);
          expect(r.txHash).toBe("");
          // Proves no string concatenation or hex encoding of project id occurred
          expect(r.txHash).not.toContain(String(id));
        }
      },
    );

    const edgeScores = [
      { cq: -1, gi: 50 },
      { cq: 101, gi: 50 },
      { cq: 50, gi: -1 },
      { cq: 50, gi: 101 },
      { cq: 9999, gi: 9999 },
      { cq: 0.5, gi: 99.5 },
      { cq: 75.25, gi: 24.75 },
      { cq: Number.MAX_SAFE_INTEGER, gi: 0 },
      { cq: 0, gi: Number.MAX_SAFE_INTEGER },
      { cq: 0, gi: 0 },
    ];
    it.each(edgeScores)(
      "safely handles extreme score inputs cq=$cq, gi=$gi without emitting fake EVM hashes",
      async ({ cq, gi }) => {
        configureChain("ethereum", {
          enabled: true,
          rpcUrl: "https://eth",
          contractAddress: "0x1",
        });
        const res = await broadcastToChains(1, cq, gi, ["ethereum"]);
        expect(res.results[0].success).toBe(false);
        expect(res.results[0].txHash).toBe("");
      },
    );

    const errorFormatCases = [
      {
        id: "ethereum" as ChainId,
        rpc: "",
        contract: undefined,
        expectedSubstr: "missing rpcUrl or contractAddress",
      },
      {
        id: "ethereum" as ChainId,
        rpc: "https://eth",
        contract: undefined,
        expectedSubstr: "missing rpcUrl or contractAddress",
      },
      {
        id: "ethereum" as ChainId,
        rpc: "",
        contract: "0x1",
        expectedSubstr: "missing rpcUrl or contractAddress",
      },
      {
        id: "ethereum" as ChainId,
        rpc: "https://eth",
        contract: "0x1",
        expectedSubstr: "EVM chain submission is not implemented for Ethereum Mainnet",
      },
      {
        id: "polygon" as ChainId,
        rpc: "",
        contract: undefined,
        expectedSubstr: "missing rpcUrl or contractAddress",
      },
      {
        id: "polygon" as ChainId,
        rpc: "https://poly",
        contract: undefined,
        expectedSubstr: "missing rpcUrl or contractAddress",
      },
      {
        id: "polygon" as ChainId,
        rpc: "",
        contract: "0x2",
        expectedSubstr: "missing rpcUrl or contractAddress",
      },
      {
        id: "polygon" as ChainId,
        rpc: "https://poly",
        contract: "0x2",
        expectedSubstr: "EVM chain submission is not implemented for Polygon",
      },
      {
        id: "polygon" as ChainId,
        rpc: "http://localhost:8545",
        contract: "0xContract",
        expectedSubstr: "EVM chain submission is not implemented for Polygon",
      },
      {
        id: "ethereum" as ChainId,
        rpc: "http://localhost:8545",
        contract: "0xContract",
        expectedSubstr: "EVM chain submission is not implemented for Ethereum Mainnet",
      },
    ];
    it.each(errorFormatCases)(
      "verifies error text format for $id with rpc='$rpc': $expectedSubstr",
      async ({ id, rpc, contract, expectedSubstr }) => {
        configureChain(id, { enabled: true, rpcUrl: rpc, contractAddress: contract });
        const res = await broadcastToChains(1, 80, 80, [id]);
        expect(res.results[0].error).toContain(expectedSubstr);
      },
    );
  });
});
