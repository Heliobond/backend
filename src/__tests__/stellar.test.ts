/**
 * Unit tests for src/lib/stellar.ts
 * Covers getRpcStatus, isRpcAvailable, isRpcOutageExtended, getAdminKeypair,
 * RpcDegradedError, and the circuit-breaker / health-tracking helpers.
 */

// Mock the heavy stellar-sdk and pool/breaker before any imports so that
// the module initialises without real network connections.
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
  TransactionBuilder: { fromXDR: jest.fn() },
  Account: jest.fn(),
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
  RpcDegradedError,
  networkPassphrase,
} from "../lib/stellar";

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
      // Fresh module state — no outage recorded
      expect(isRpcOutageExtended(1000)).toBe(false);
    });

    it("returns false for a large threshold even when recently started", () => {
      expect(isRpcOutageExtended(Number.MAX_SAFE_INTEGER)).toBe(false);
    });
  });

  describe("getAdminKeypair", () => {
    afterEach(() => {
      delete process.env.ADMIN_SECRET_KEY;
    });

    it("throws when ADMIN_SECRET_KEY is unset", () => {
      delete process.env.ADMIN_SECRET_KEY;
      expect(() => getAdminKeypair()).toThrow("ADMIN_SECRET_KEY not set");
    });

    it("returns a keypair when ADMIN_SECRET_KEY is set", () => {
      process.env.ADMIN_SECRET_KEY = "STEST000000000000000000000000000000000000000000000000000";
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
});
