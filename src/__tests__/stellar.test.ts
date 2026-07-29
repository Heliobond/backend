/**
 * Unit tests for src/lib/stellar.ts
 * Covers getRpcStatus, isRpcAvailable, isRpcOutageExtended, getAdminKeypair,
 * RpcDegradedError, signAndSubmit, and the circuit-breaker / health-tracking helpers.
 */

const mockConfig: Record<string, unknown> = {
  STELLAR_NETWORK: "testnet",
  ADMIN_SECRET_KEY: "",
  RPC_URL: "https://soroban-testnet.stellar.org",
  DB_POOL_MIN: 2,
  DB_POOL_MAX: 10,
  DB_POOL_ACQUIRE_TIMEOUT_MS: 5000,
  DB_POOL_HEALTH_CHECK_INTERVAL_MS: 30000,
  RPC_BREAKER_FAILURE_THRESHOLD: 5,
  RPC_BREAKER_RECOVERY_TIMEOUT_MS: 30000,
  TX_MAX_RETRIES: 4,
  TX_RETRY_BASE_DELAY_MS: 200,
  TX_RETRY_MAX_DELAY_MS: 10000,
};

jest.mock("../config", () => ({
  get config() {
    return mockConfig;
  },
}));

const mockTx = {
  operations: [{ type: "invoke" }],
  fee: 100,
  timeBounds: undefined,
  sign: jest.fn(),
};

jest.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    fromSecret: jest.fn().mockReturnValue({ publicKey: () => "GPUBKEY" }),
    random: jest.fn().mockReturnValue({ secret: () => "SRANDOM" }),
  },
  rpc: {
    Server: jest.fn(),
    Api: { GetTransactionStatus: { NOT_FOUND: "NOT_FOUND", FAILED: "FAILED" } },
  },
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
  TransactionBuilder: {
    fromXDR: jest.fn().mockReturnValue({
      operations: [{ type: "invoke" }],
      fee: 100,
      timeBounds: undefined,
      tx: { timeBounds: undefined },
      sign: jest.fn(),
    }),
    mockReset(tx?: unknown) {
      (this as any).fromXDR.mockReturnValue(tx ?? mockTx);
    },
  },
  Account: jest.fn().mockImplementation((id: string, seq: string) => ({ id, seq })),
  xdr: {
    LedgerKey: { account: jest.fn().mockReturnValue({}) },
    LedgerKeyAccount: jest.fn(),
  },
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

import {
  getRpcStatus,
  isRpcAvailable,
  isRpcOutageExtended,
  getAdminKeypair,
  signAndSubmit,
  RpcDegradedError,
  networkPassphrase,
} from "../lib/stellar";
import { rpc, TransactionBuilder } from "@stellar/stellar-sdk";

describe("stellar utility helpers", () => {
  describe("networkPassphrase", () => {
    it("is a non-empty string", () => {
      expect(typeof networkPassphrase).toBe("string");
      expect(networkPassphrase.length).toBeGreaterThan(0);
    });
  });

  describe("getRpcStatus", () => {
    it("returns an object with the expected shape", () => {
      const status = getRpcStatus();
      expect(typeof status.consecutiveFailures).toBe("number");
      expect(typeof status.outageDurationMs).toBe("number");
      expect(typeof status.lastSuccessAgoMs).toBe("number");
    });

    it("consecutiveFailures is non-negative", () => {
      expect(getRpcStatus().consecutiveFailures).toBeGreaterThanOrEqual(0);
    });

    it("outageDurationMs is non-negative", () => {
      expect(getRpcStatus().outageDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("isRpcAvailable", () => {
    it("returns a boolean", () => {
      expect(typeof isRpcAvailable()).toBe("boolean");
    });
  });

  describe("isRpcOutageExtended", () => {
    it("returns false when no outage is active", () => {
      expect(isRpcOutageExtended(1000)).toBe(false);
    });

    it("returns false for a large threshold even when recently started", () => {
      expect(isRpcOutageExtended(Number.MAX_SAFE_INTEGER)).toBe(false);
    });
  });

  describe("getAdminKeypair", () => {
    it("throws when ADMIN_SECRET_KEY is unset", () => {
      mockConfig.ADMIN_SECRET_KEY = "";
      expect(() => getAdminKeypair()).toThrow("ADMIN_SECRET_KEY not set");
    });

    it("returns a keypair when ADMIN_SECRET_KEY is set", () => {
      mockConfig.ADMIN_SECRET_KEY = "STEST000000000000000000000000000000000000000000000000000";
      const kp = getAdminKeypair();
      expect(kp).toBeDefined();
    });
  });

  describe("RpcDegradedError", () => {
    it("is an instance of Error", () => {
      const err = new RpcDegradedError();
      expect(err).toBeInstanceOf(Error);
    });

    it("has name RpcDegradedError", () => {
      expect(new RpcDegradedError().name).toBe("RpcDegradedError");
    });

    it("accepts a custom message", () => {
      const err = new RpcDegradedError("custom message");
      expect(err.message).toBe("custom message");
    });

    it("uses default message when none is provided", () => {
      expect(new RpcDegradedError().message).toBe("RPC is degraded");
    });
  });

  describe("signAndSubmit", () => {
    const mockKeypair = {
      publicKey: () => "GPUBKEY",
      xdrPublicKey: () => "XDR_PUB_KEY",
      sign: jest.fn(),
    };

    const createMockClient = (
      overrides: Partial<{
        getLedgerEntries: jest.Mock;
        sendTransaction: jest.Mock;
        getTransaction: jest.Mock;
      }> = {},
    ) => ({
      getLedgerEntries: jest.fn().mockResolvedValue({ entries: [] }),
      sendTransaction: jest.fn().mockResolvedValue({
        status: "SUCCESS",
        hash: "tx_hash_123",
      }),
      getTransaction: jest.fn().mockResolvedValue({
        status: "SUCCESS",
      }),
      ...overrides,
    });

    beforeEach(() => {
      jest.clearAllMocks();
      const freshTx = {
        operations: [{ type: "invoke" }],
        fee: 100,
        timeBounds: undefined,
        sign: jest.fn(),
      };
      (TransactionBuilder as any).fromXDR.mockReturnValue({
        ...freshTx,
        tx: { timeBounds: undefined },
      });
    });

    it("returns tx hash on successful submission", async () => {
      const client = createMockClient({
        sendTransaction: jest.fn().mockResolvedValue({
          status: "SUCCESS",
          hash: "abc123",
        }),
        getTransaction: jest.fn().mockResolvedValue({
          status: "SUCCESS",
        }),
      });

      const result = await signAndSubmit(client as any, "fake_xdr", mockKeypair as any);
      expect(result).toBe("abc123");
    });

    it("throws on ERROR status from sendTransaction", async () => {
      const client = createMockClient({
        sendTransaction: jest.fn().mockResolvedValue({
          status: "ERROR",
          errorResult: { code: -1, message: "tx_bad_seq" },
        }),
      });

      await expect(signAndSubmit(client as any, "fake_xdr", mockKeypair as any)).rejects.toThrow(
        "Send error",
      );
    }, 15000);

    it("throws on FAILED status from getTransaction", async () => {
      const client = createMockClient({
        sendTransaction: jest.fn().mockResolvedValue({
          status: "SUCCESS",
          hash: "fail_hash",
        }),
        getTransaction: jest.fn().mockResolvedValue({
          status: "FAILED",
        }),
      });

      await expect(signAndSubmit(client as any, "fake_xdr", mockKeypair as any)).rejects.toThrow(
        "Transaction failed on-chain",
      );
    }, 15000);

    it("throws a timeout error when polling exceeds the max attempts", async () => {
      const client = createMockClient({
        sendTransaction: jest.fn().mockResolvedValue({
          status: "SUCCESS",
          hash: "pending_hash",
        }),
        // Always NOT_FOUND — never confirms, forcing the poll loop to exhaust
        // its max attempts (20) and throw the timeout error.
        getTransaction: jest.fn().mockResolvedValue({
          status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        }),
      });

      await expect(signAndSubmit(client as any, "fake_xdr", mockKeypair as any)).rejects.toThrow(
        "Transaction confirmation timeout",
      );
      // 20 max attempts before throwing
      expect(client.getTransaction).toHaveBeenCalledTimes(21);
    }, 15000);
  });
});
