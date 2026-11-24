const CONTRACT_ID = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
const ADMIN_KEY = "test-key";

jest.mock("../config", () => {
  const actual = jest.requireActual("../config");
  return {
    config: {
      ...actual.config,
      PROJECT_REGISTRY_CONTRACT_ID: "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR",
      ADMIN_API_KEY: "test-key",
    },
  };
});

import { Keypair, Transaction, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import express, { Express } from "express";
import request from "supertest";
import {
  buildSetWhitelistTx,
  buildCreateProjectTx,
  prepareOnboardingTransaction,
  executeClientOnboardingTransaction,
  ONBOARDING_TX_PREPARATION_CONTRACT,
  resetCreatorApplications,
  setMetadataPinner,
} from "../lib/creatorOnboarding";
import { creatorApplicationsRouter, creatorAdminRouter } from "../routes/creatorApplications";
import { errorHandler } from "../middleware/errors";
import { networkPassphrase } from "../lib/stellar";
import { config } from "../config";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/creators", creatorApplicationsRouter);
  app.use("/admin/creators", creatorAdminRouter);
  app.use(errorHandler);
  return app;
}

describe("creator onboarding transaction simulation and preparation contract (#1005)", () => {
  let app: Express;
  const creatorKeypair = Keypair.random();
  const whitelisterKeypair = Keypair.random();
  const CREATOR = creatorKeypair.publicKey();
  const WHITELISTER = whitelisterKeypair.publicKey();

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.WALLET_AUTH_REQUIRE_SIGNATURE = "false";
    (config as Record<string, unknown>).PROJECT_REGISTRY_CONTRACT_ID = CONTRACT_ID;
    resetCreatorApplications();
    setMetadataPinner(null);
    app = buildApp();
  });

  afterEach(() => {
    delete process.env.WALLET_AUTH_REQUIRE_SIGNATURE;
  });

  describe("simulation and assembly integration", () => {
    it("confirms resulting set_whitelist transaction simulates and assembles successfully", async () => {
      const unsignedXdr = buildSetWhitelistTx({
        contractId: CONTRACT_ID,
        sourceAccount: WHITELISTER,
        sequence: "10",
        account: CREATOR,
      });

      const parsedTx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase) as Transaction;
      expect(parsedTx.signatures).toHaveLength(0);
      expect(parsedTx.source).toBe(WHITELISTER);
      expect(parsedTx.operations).toHaveLength(1);
      expect(parsedTx.operations[0].type).toBe("invokeHostFunction");

      // Mock RPC simulation server with prepareTransaction (simulates and assembles resources)
      const mockServer = {
        simulateTransaction: jest.fn().mockResolvedValue({
          id: "sim-1",
          latestLedger: 100,
          cost: { cpuInsns: "100", memBytes: "100" },
          minResourceFee: "50",
          results: [],
        } as unknown as rpc.Api.SimulateTransactionResponse),
        prepareTransaction: jest.fn().mockImplementation(async (tx: Transaction) => tx),
      };

      const preparedXdr = await prepareOnboardingTransaction(unsignedXdr, mockServer);
      expect(mockServer.prepareTransaction).toHaveBeenCalledTimes(1);

      const assembledTx = TransactionBuilder.fromXDR(preparedXdr, networkPassphrase) as Transaction;
      expect(Number(assembledTx.fee)).toBeGreaterThanOrEqual(Number(parsedTx.fee));
      expect(assembledTx.operations).toHaveLength(1);
    });

    it("confirms resulting create_project transaction simulates and assembles successfully", async () => {
      const unsignedXdr = buildCreateProjectTx({
        contractId: CONTRACT_ID,
        sourceAccount: CREATOR,
        sequence: "42",
        creator: CREATOR,
        uri: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
        maturityDate: 2000000000,
        metadataHash: "e".repeat(64),
      });

      const parsedTx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase) as Transaction;
      expect(parsedTx.signatures).toHaveLength(0);
      expect(parsedTx.source).toBe(CREATOR);
      expect(parsedTx.operations).toHaveLength(1);
      expect(parsedTx.operations[0].type).toBe("invokeHostFunction");

      const mockServer = {
        simulateTransaction: jest.fn().mockResolvedValue({
          id: "sim-2",
          latestLedger: 100,
          cost: { cpuInsns: "200", memBytes: "200" },
          minResourceFee: "100",
          results: [],
        } as unknown as rpc.Api.SimulateTransactionResponse),
        prepareTransaction: jest.fn().mockImplementation(async (tx: Transaction) => tx),
      };

      const preparedXdr = await prepareOnboardingTransaction(unsignedXdr, mockServer);
      expect(mockServer.prepareTransaction).toHaveBeenCalledTimes(1);

      const assembledTx = TransactionBuilder.fromXDR(preparedXdr, networkPassphrase) as Transaction;
      expect(Number(assembledTx.fee)).toBeGreaterThanOrEqual(Number(parsedTx.fee));
    });
  });

  describe("client execution pipeline", () => {
    it("takes returned transaction through simulate, assemble, sign, and submit steps", async () => {
      const unsignedXdr = buildCreateProjectTx({
        contractId: CONTRACT_ID,
        sourceAccount: CREATOR,
        sequence: "5",
        creator: CREATOR,
        uri: "ipfs://bafyexample",
        maturityDate: 2000000000,
        metadataHash: "f".repeat(64),
      });

      const mockRpcServer = {
        simulateTransaction: jest.fn().mockResolvedValue({
          id: "sim-3",
          latestLedger: 100,
          cost: { cpuInsns: "200", memBytes: "200" },
          minResourceFee: "100",
          results: [],
        } as unknown as rpc.Api.SimulateTransactionResponse),
        prepareTransaction: jest.fn().mockImplementation(async (tx: Transaction) => tx),
        sendTransaction: jest.fn().mockResolvedValue({
          status: "PENDING",
          hash: "txhash-submission-abc123",
        }),
      };

      const result = await executeClientOnboardingTransaction({
        unsignedXdr,
        signerKeypair: creatorKeypair,
        rpcServer: mockRpcServer,
      });

      expect(result.simulated).toBe(true);
      expect(result.submission_tx_hash).toBe("txhash-submission-abc123");
      expect(result.steps.map((s) => s.step)).toEqual(["simulate", "assemble", "sign", "submit"]);
      expect(result.steps.every((s) => s.status === "success")).toBe(true);

      // Verify signed XDR has creator signature
      const signedTx = TransactionBuilder.fromXDR(
        result.signed_xdr,
        networkPassphrase,
      ) as Transaction;
      expect(signedTx.signatures).toHaveLength(1);
    });
  });

  describe("HTTP preparation contract in API responses", () => {
    it("exposes explicit preparation contract in create-project-tx response", async () => {
      // 1. Submit application
      const submitRes = await request(app)
        .post("/creators/applications")
        .set("x-wallet-address", CREATOR)
        .send({
          name: "Sol Project",
          location: "Accra, Ghana",
          capacity_kw: 100,
          documents: ["ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"],
        })
        .expect(201);

      const appId = submitRes.body.id;

      // 2. Advance review to approved
      await request(app)
        .patch(`/admin/creators/applications/${appId}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "in_review" })
        .expect(200);

      const approveRes = await request(app)
        .patch(`/admin/creators/applications/${appId}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({
          status: "approved",
          whitelister: WHITELISTER,
          whitelister_sequence: "1",
        })
        .expect(200);

      // Admin response includes explicit preparation contract for set_whitelist_tx
      expect(approveRes.body.set_whitelist_prepared).toBe(false);
      expect(approveRes.body.set_whitelist_preparation).toEqual(ONBOARDING_TX_PREPARATION_CONTRACT);
      expect(approveRes.body.set_whitelist_preparation.simulation_required).toBe(true);
      expect(approveRes.body.set_whitelist_preparation.resource_assembly_required).toBe(true);

      // Confirm whitelist so application is ready for registration (#1004)
      await request(app)
        .post(`/admin/creators/applications/${appId}/confirm-whitelist`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ tx_hash: "mock-tx-hash-1", actor: "admin_whitelister" })
        .expect(200);

      // 3. Creator requests create-project-tx
      const txRes = await request(app)
        .get(
          `/creators/applications/${appId}/create-project-tx?sequence=2&maturity_date=2000000000`,
        )
        .set("x-wallet-address", CREATOR)
        .expect(200);

      expect(txRes.body.signed).toBe(false);
      expect(txRes.body.prepared).toBe(false);
      expect(txRes.body.preparation).toEqual(ONBOARDING_TX_PREPARATION_CONTRACT);
      expect(txRes.body.preparation.simulation_required).toBe(true);
      expect(txRes.body.preparation.resource_assembly_required).toBe(true);
      expect(txRes.body.preparation.steps).toEqual([
        "simulateTransaction",
        "assembleTransaction",
        "signTransaction",
        "sendTransaction",
      ]);
    });
  });
});
