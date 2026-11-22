/**
 * Tests for the admin keypair cache (#227).
 *
 * getAdminKeypair() used to re-derive the Ed25519 keypair from the secret on
 * every call, which in the cron loop meant one derivation per project per
 * cycle. It now derives once and reuses the result.
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

jest.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    // Fresh object per call so identity comparison proves the cache is used.
    fromSecret: jest.fn((secret: string) => ({ publicKey: () => `PUB:${secret}` })),
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
    LedgerKey: { account: jest.fn() },
    LedgerKeyAccount: jest.fn(),
  },
}));

import { getAdminKeypair, resetAdminKeypairCache } from "../lib/stellar";
import { Keypair } from "@stellar/stellar-sdk";

const fromSecret = Keypair.fromSecret as unknown as jest.Mock;

describe("getAdminKeypair caching (#227)", () => {
  beforeEach(() => {
    resetAdminKeypairCache();
    fromSecret.mockClear();
    mockConfig.ADMIN_SECRET_KEY = "SSECRET1";
  });

  it("derives the keypair only once across repeated calls", () => {
    getAdminKeypair();
    getAdminKeypair();
    getAdminKeypair();

    expect(fromSecret).toHaveBeenCalledTimes(1);
    expect(fromSecret).toHaveBeenCalledWith("SSECRET1");
  });

  it("returns the identical cached instance on subsequent calls", () => {
    const first = getAdminKeypair();
    const second = getAdminKeypair();

    expect(second).toBe(first);
  });

  it("stays cached across a simulated cron cycle over many projects", () => {
    for (let projectId = 1; projectId <= 50; projectId++) {
      getAdminKeypair();
    }

    expect(fromSecret).toHaveBeenCalledTimes(1);
  });

  it("throws the same error when ADMIN_SECRET_KEY is not set", () => {
    mockConfig.ADMIN_SECRET_KEY = "";

    expect(() => getAdminKeypair()).toThrow("ADMIN_SECRET_KEY not set");
    expect(fromSecret).not.toHaveBeenCalled();
  });

  it("still throws on a missing secret even after a successful derivation", () => {
    getAdminKeypair();
    expect(fromSecret).toHaveBeenCalledTimes(1);

    mockConfig.ADMIN_SECRET_KEY = "";
    expect(() => getAdminKeypair()).toThrow("ADMIN_SECRET_KEY not set");
  });

  it("re-derives when the configured secret changes", () => {
    const first = getAdminKeypair();

    mockConfig.ADMIN_SECRET_KEY = "SSECRET2";
    const second = getAdminKeypair();

    expect(fromSecret).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second.publicKey()).toBe("PUB:SSECRET2");
  });

  it("resetAdminKeypairCache forces the next call to derive again", () => {
    getAdminKeypair();
    resetAdminKeypairCache();
    getAdminKeypair();

    expect(fromSecret).toHaveBeenCalledTimes(2);
  });
});
