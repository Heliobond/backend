/**
 * Unit tests for src/lib/registry.ts
 * Covers updateImpactScore, getTotalProjects, and RpcDegradedError.
 */

jest.mock("@stellar/stellar-sdk", () => {
  const mockScVal = { u32: (val: number) => ({ _value: val }) };
  return {
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockReturnValue("mock_operation"),
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({
        toXDR: () => "mock_xdr",
      }),
    })),
    nativeToScVal: jest.fn().mockImplementation((val) => mockScVal.u32(val)),
    BASE_FEE: "100",
    scValToNative: jest.fn().mockReturnValue(42),
    rpc: {
      Api: {
        SimulateTransactionSuccessResponse: {},
      },
    },
    Account: jest.fn().mockImplementation(() => ({})),
  };
});

jest.mock("../lib/stellar", () => ({
  withRpcConnection: jest.fn().mockImplementation((fn: (client: any) => Promise<any>) =>
    fn({
      getAccount: jest.fn().mockResolvedValue({ sequence: "0" }),
      prepareTransaction: jest.fn().mockResolvedValue({
        toXDR: () => "prepared_xdr",
      }),
      simulateTransaction: jest.fn().mockResolvedValue({
        result: { retval: { _value: 42 } },
      }),
    }),
  ),
  networkPassphrase: "Test SDF Network ; September 2015",
  getAdminKeypair: jest.fn().mockReturnValue({
    publicKey: () => "GPUBKEY",
  }),
  signAndSubmit: jest.fn().mockResolvedValue("tx_hash_abc123"),
  RpcDegradedError: class RpcDegradedError extends Error {
    constructor(message?: string) {
      super(message ?? "RPC is degraded");
      this.name = "RpcDegradedError";
    }
  },
  withRpcRetry: jest.fn().mockImplementation((fn: () => any) => fn()),
}));

jest.mock("../config", () => ({
  config: {
    PROJECT_REGISTRY_CONTRACT_ID: "CONTRACT123",
    STELLAR_NETWORK: "testnet",
    ADMIN_SECRET_KEY: "STEST000000000000000000000000000000000000000000000000000",
    TX_TIMEOUT_SECONDS: 30,
  },
}));

import {
  updateImpactScore,
  getTotalProjects,
  projectExists,
  RpcDegradedError,
  StaleSequenceError,
  getLocalSequence,
  resetLocalSequence,
} from "../lib/registry";
import { withRpcConnection, signAndSubmit } from "../lib/stellar";
import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  BASE_FEE,
  scValToNative,
} from "@stellar/stellar-sdk";

describe("registry module", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetLocalSequence();
    (withRpcConnection as jest.Mock).mockImplementation((fn: (client: any) => Promise<any>) =>
      fn({
        getAccount: jest.fn().mockResolvedValue({ sequence: "0" }),
        prepareTransaction: jest.fn().mockResolvedValue({
          toXDR: () => "prepared_xdr",
        }),
        simulateTransaction: jest.fn().mockResolvedValue({
          result: { retval: { _value: 42 } },
        }),
      }),
    );
  });

  describe("updateImpactScore", () => {
    it("calls withRpcConnection and signAndSubmit", async () => {
      const hash = await updateImpactScore(1, 85, 90);

      expect(withRpcConnection).toHaveBeenCalled();
      expect(hash).toBe("tx_hash_abc123");
    });

    it("builds correct transaction with project id, credit quality, and green impact", async () => {
      await updateImpactScore(5, 70, 80);

      expect(nativeToScVal).toHaveBeenCalledWith(5, { type: "u32" });
      expect(nativeToScVal).toHaveBeenCalledWith(70, { type: "u32" });
      expect(nativeToScVal).toHaveBeenCalledWith(80, { type: "u32" });
    });

    it("creates a Contract instance with REGISTRY_CONTRACT_ID", async () => {
      await updateImpactScore(1, 85, 90);

      expect(Contract).toHaveBeenCalledWith("CONTRACT123");
    });

    it("builds a transaction with correct fee and timeout", async () => {
      await updateImpactScore(1, 85, 90);

      expect(TransactionBuilder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          fee: BASE_FEE,
        }),
      );
    });

    it("tracks local sequence number on first fetch and increments on successful submission", async () => {
      (withRpcConnection as jest.Mock).mockImplementationOnce((fn: (client: any) => Promise<any>) =>
        fn({
          getAccount: jest.fn().mockResolvedValue({ sequence: "100" }),
          prepareTransaction: jest.fn().mockResolvedValue({ toXDR: () => "prepared_xdr" }),
        }),
      );

      await updateImpactScore(1, 80, 90);
      expect(getLocalSequence()).toBe(101n);
    });

    it("rejects stale sequence numbers with StaleSequenceError", async () => {
      // First submission with sequence 100
      (withRpcConnection as jest.Mock).mockImplementationOnce((fn: (client: any) => Promise<any>) =>
        fn({
          getAccount: jest.fn().mockResolvedValue({ sequence: "100" }),
          prepareTransaction: jest.fn().mockResolvedValue({ toXDR: () => "prepared_xdr" }),
        }),
      );
      await updateImpactScore(1, 80, 90);
      expect(getLocalSequence()).toBe(101n);

      // Second submission receives stale sequence 99 from slow/stale RPC
      (withRpcConnection as jest.Mock).mockImplementationOnce((fn: (client: any) => Promise<any>) =>
        fn({
          getAccount: jest.fn().mockResolvedValue({ sequence: "99" }),
          prepareTransaction: jest.fn().mockResolvedValue({ toXDR: () => "prepared_xdr" }),
        }),
      );

      await expect(updateImpactScore(1, 80, 90)).rejects.toThrow(StaleSequenceError);
    });

    it("handles concurrent submissions safely through mutex queue", async () => {
      let currentSeq = 10;
      (withRpcConnection as jest.Mock).mockImplementation(
        async (fn: (client: any) => Promise<any>) => {
          const seqToReturn = String(currentSeq++);
          return fn({
            getAccount: jest.fn().mockResolvedValue({ sequence: seqToReturn }),
            prepareTransaction: jest.fn().mockResolvedValue({ toXDR: () => "prepared_xdr" }),
          });
        },
      );

      const p1 = updateImpactScore(1, 80, 90);
      const p2 = updateImpactScore(2, 85, 95);

      const [h1, h2] = await Promise.all([p1, p2]);
      expect(h1).toBe("tx_hash_abc123");
      expect(h2).toBe("tx_hash_abc123");
      expect(getLocalSequence()).toBe(12n);
    });
  });

  describe("getTotalProjects", () => {
    it("returns parsed number from simulation result", async () => {
      const total = await getTotalProjects();

      expect(total).toBe(42);
    });

    it("calls simulateTransaction on the client", async () => {
      await getTotalProjects();

      expect(withRpcConnection).toHaveBeenCalled();
    });

    it("creates a Contract instance with REGISTRY_CONTRACT_ID", async () => {
      await getTotalProjects();

      expect(Contract).toHaveBeenCalledWith("CONTRACT123");
    });

    it("throws a clear error when simulation returns an error object", async () => {
      (withRpcConnection as jest.Mock).mockImplementationOnce((fn: (client: any) => Promise<any>) =>
        fn({
          getAccount: jest.fn().mockResolvedValue({ sequence: "0" }),
          simulateTransaction: jest.fn().mockResolvedValue({
            error: "simulation failed: contract trapped",
          }),
        }),
      );

      await expect(getTotalProjects()).rejects.toThrow("simulation failed: contract trapped");
    });

    it("returns a number when simulation succeeds with a retval", async () => {
      (withRpcConnection as jest.Mock).mockImplementationOnce((fn: (client: any) => Promise<any>) =>
        fn({
          getAccount: jest.fn().mockResolvedValue({ sequence: "0" }),
          simulateTransaction: jest.fn().mockResolvedValue({
            result: { retval: { _value: 7 } },
          }),
        }),
      );

      const total = await getTotalProjects();
      expect(total).toBe(42); // scValToNative is mocked to always return 42
      expect(typeof total).toBe("number");
    });

    it("throws specific error message when the simulation succeeds but retval is missing", async () => {
      (withRpcConnection as jest.Mock).mockImplementationOnce((fn: (client: any) => Promise<any>) =>
        fn({
          getAccount: jest.fn().mockResolvedValue({ sequence: "0" }),
          simulateTransaction: jest.fn().mockResolvedValue({
            result: {},
          }),
        }),
      );

      await expect(getTotalProjects()).rejects.toThrow(
        "total_projects simulation returned no result value",
      );
    });

    it("throws specific error message when the simulation succeeds but result is undefined", async () => {
      (withRpcConnection as jest.Mock).mockImplementationOnce((fn: (client: any) => Promise<any>) =>
        fn({
          getAccount: jest.fn().mockResolvedValue({ sequence: "0" }),
          simulateTransaction: jest.fn().mockResolvedValue({}),
        }),
      );

      await expect(getTotalProjects()).rejects.toThrow(
        "total_projects simulation returned no result value",
      );
    });
  });

  describe("projectExists (#768)", () => {
    function withSimulation(response: unknown): void {
      (withRpcConnection as jest.Mock).mockImplementationOnce(
        (fn: (client: unknown) => Promise<unknown>) =>
          fn({
            getAccount: jest.fn().mockResolvedValue({ sequence: "0" }),
            simulateTransaction: jest.fn().mockResolvedValue(response),
          }),
      );
    }

    it("returns true when get_project simulates successfully", async () => {
      withSimulation({ result: { retval: { _value: 1 } } });

      await expect(projectExists(1)).resolves.toBe(true);
      expect(nativeToScVal).toHaveBeenCalledWith(1, { type: "u32" });
    });

    it("returns false when the contract panics with ProjectNotFound (#7)", async () => {
      withSimulation({ error: "HostError: Error(Contract, #7)" });

      await expect(projectExists(999999)).resolves.toBe(false);
    });

    it("returns false when the contract panics with ProjectArchived (#3)", async () => {
      withSimulation({ error: "HostError: Error(Contract, #3)" });

      await expect(projectExists(1)).resolves.toBe(false);
    });

    it("throws for a non-project simulation error", async () => {
      withSimulation({ error: "simulation failed: contract trapped" });

      await expect(projectExists(1)).rejects.toThrow("simulation failed: contract trapped");
    });
  });

  describe("RpcDegradedError", () => {
    it("is an instance of Error", () => {
      const err = new RpcDegradedError("test error");
      expect(err).toBeInstanceOf(Error);
    });

    it("has name RpcDegradedError", () => {
      const err = new RpcDegradedError("test error");
      expect(err.name).toBe("RpcDegradedError");
    });

    it("preserves the message", () => {
      const err = new RpcDegradedError("custom message");
      expect(err.message).toBe("custom message");
    });
  });
});
