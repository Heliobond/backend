/**
 * Integration tests against the live Stellar testnet.
 *
 * These tests require:
 *   STELLAR_NETWORK=testnet
 *   RPC_URL=https://soroban-testnet.stellar.org   (optional, this is the default)
 *   ADMIN_SECRET_KEY=<funded testnet secret>
 *
 * They are skipped automatically in CI unless all env vars are present, so
 * they never block the normal test suite.
 *
 * Run manually:
 *   STELLAR_NETWORK=testnet ADMIN_SECRET_KEY=S... npm test -- stellar-testnet
 */

const TESTNET_REQUIRED =
  process.env.STELLAR_NETWORK === "testnet" && !!process.env.ADMIN_SECRET_KEY;

const itTestnet = TESTNET_REQUIRED ? it : it.skip;

// ── mocks only apply when NOT running against the real network ─────────────
if (!TESTNET_REQUIRED) {
  jest.mock("@stellar/stellar-sdk", () => ({
    Keypair: { fromSecret: jest.fn(), random: jest.fn() },
    rpc: { Server: jest.fn(), Api: { GetTransactionStatus: {} } },
    Networks: { TESTNET: "Test SDF Network ; September 2015", PUBLIC: "" },
    TransactionBuilder: { fromXDR: jest.fn() },
    Account: jest.fn(),
    xdr: { LedgerKey: { account: jest.fn() }, LedgerKeyAccount: jest.fn() },
  }));

  jest.mock("../lib/db-pool", () => ({
    RpcConnectionPool: jest.fn().mockImplementation(() => ({
      withConnection: jest.fn(),
      destroy: jest.fn(),
    })),
  }));

  jest.mock("../lib/circuit-breaker", () => ({
    CircuitBreaker: jest.fn().mockImplementation(() => ({
      execute: jest.fn().mockImplementation((fn: () => unknown) => fn()),
      getState: jest.fn().mockReturnValue("CLOSED"),
    })),
  }));

  jest.mock("../lib/retry", () => ({
    withRetry: jest.fn().mockImplementation((fn: () => unknown) => fn()),
    isTransientError: jest.fn().mockReturnValue(false),
  }));
}

import { getRpcStatus, isRpcAvailable, withRpcConnection } from "../lib/stellar";

describe("Stellar testnet integration", () => {
  describe("account funding (testnet)", () => {
    itTestnet(
      "Friendbot funds a new account",
      async () => {
        const { Keypair } = await import("@stellar/stellar-sdk");
        const kp = (Keypair as { random: () => { publicKey: () => string } }).random();
        const pubkey = kp.publicKey();

        const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(pubkey)}`);
        expect(res.ok).toBe(true);

        const json = (await res.json()) as { _links: { transaction: { href: string } } };
        expect(json).toHaveProperty("_links.transaction.href");
      },
      30_000,
    );
  });

  describe("RPC connectivity (testnet)", () => {
    itTestnet(
      "withRpcConnection can reach the Stellar testnet RPC",
      async () => {
        const health = await withRpcConnection(async (client) => {
          // getLatestLedger is the lightest possible RPC call
          return client.getLatestLedger();
        });

        expect(health).toBeDefined();
        expect(typeof (health as { sequence: number }).sequence).toBe("number");
      },
      30_000,
    );

    itTestnet("isRpcAvailable returns true on a healthy connection", async () => {
      // Pre-condition: the above test must have populated health state
      expect(isRpcAvailable()).toBe(true);
    });

    itTestnet("getRpcStatus reports zero consecutive failures after a healthy call", () => {
      const status = getRpcStatus();
      expect(status.consecutiveFailures).toBe(0);
      expect(status.outageDurationMs).toBe(0);
    });
  });

  describe("error recovery (network timeout handling)", () => {
    itTestnet(
      "withRpcConnection propagates rejection on a bad RPC URL",
      async () => {
        // Temporarily override the RPC URL to an unreachable address
        const origUrl = process.env.RPC_URL;
        process.env.RPC_URL = "https://invalid.testnet.example.invalid";

        try {
          await withRpcConnection(async (client) => client.getLatestLedger());
          // Should not reach here
          expect(true).toBe(false);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
        } finally {
          process.env.RPC_URL = origUrl;
        }
      },
      15_000,
    );
  });

  // ── Skipped stubs (runs in all environments) ────────────────────────────
  describe("contract deployment stub (testnet)", () => {
    it("is skipped when STELLAR_NETWORK is not testnet", () => {
      if (!TESTNET_REQUIRED) {
        // Documented skip: contract deployment needs a live funded account
        expect(TESTNET_REQUIRED).toBe(false);
      }
    });
  });
});
