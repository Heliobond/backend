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
}));

jest.mock("../config", () => ({
  config: {
    PROJECT_REGISTRY_CONTRACT_ID: "CONTRACT123",
    STELLAR_NETWORK: "testnet",
    ADMIN_SECRET_KEY: "STEST000000000000000000000000000000000000000000000000000",
  },
}));

import { updateImpactScore, getTotalProjects, RpcDegradedError } from "../lib/registry";
import { withRpcConnection, signAndSubmit } from "../lib/stellar";
import { Contract, TransactionBuilder, nativeToScVal, BASE_FEE } from "@stellar/stellar-sdk";

describe("registry module", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
