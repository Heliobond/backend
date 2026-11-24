/**
 * Creator onboarding integrity (#995, #996, #997, #998).
 *
 *  - #995 set_whitelist serializes (account, status, valid_until) in registry order.
 *  - #996 maturity_date is carried exactly as a u64 (no JS number rounding).
 *  - #997 concurrent reviews cannot both commit after the async pinner.
 *  - #998 ProjectCreated links by metadata hash AND creator.
 */
const CONTRACT_ID = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
const ADMIN_KEY = "test-key";

jest.mock("../config", () => {
  const actual = jest.requireActual("../config");
  return {
    config: {
      ...actual.config,
      PROJECT_REGISTRY_CONTRACT_ID: "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR",
      ADMIN_API_KEY: "test-key",
    },
  };
});

import request from "supertest";
import express, { Express } from "express";
import {
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { creatorApplicationsRouter, creatorAdminRouter } from "../routes/creatorApplications";
import { errorHandler } from "../middleware/errors";
import {
  CreatorProjectMetadata,
  MetadataPinner,
  PERMANENT_WHITELIST_VALID_UNTIL,
  U64_MAX,
  buildCreateProjectTx,
  buildSetWhitelistTx,
  computeMetadataHash,
  getApplication,
  linkProjectToApplication,
  prepareOnboardingTransaction,
  resetCreatorApplications,
  setMetadataPinner,
} from "../lib/creatorOnboarding";
import { indexer } from "../lib/indexer";
import { networkPassphrase } from "../lib/stellar";
import * as notifications from "../lib/notifications";

jest.spyOn(notifications, "notify").mockResolvedValue(undefined as never);

const WALLET_A = Keypair.random().publicKey();
const WALLET_B = Keypair.random().publicKey();
const WHITELISTER = Keypair.random().publicKey();

const metadata: CreatorProjectMetadata = {
  name: "Sunfield Array A",
  location: "Lagos, Nigeria",
  capacity_kw: 250.5,
  documents: ["ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"],
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/creators", creatorApplicationsRouter);
  app.use("/admin/creators", creatorAdminRouter);
  app.use(errorHandler);
  return app;
}

function admin(app: Express, id: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/admin/creators/applications/${id}`)
    .set("Authorization", `Bearer ${ADMIN_KEY}`)
    .send(body);
}

async function submitAs(app: Express, wallet: string): Promise<string> {
  const res = await request(app)
    .post("/creators/applications")
    .set("x-wallet-address", wallet)
    .send(metadata)
    .expect(201);
  return res.body.id as string;
}

async function approveAs(app: Express, wallet: string): Promise<string> {
  const id = await submitAs(app, wallet);
  await admin(app, id, { status: "in_review" }).expect(200);
  await admin(app, id, { status: "approved" }).expect(200);
  return id;
}

interface Invocation {
  fn: string;
  args: xdr.ScVal[];
}

function invocationOf(tx: Transaction): Invocation {
  expect(tx.operations).toHaveLength(1);
  const op = tx.operations[0] as unknown as { type: string; func: xdr.HostFunction };
  expect(op.type).toBe("invokeHostFunction");
  if (op.func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error(`expected invokeContract, got ${op.func.type}`);
  }
  const invoke = op.func.invokeContract;
  return { fn: invoke.functionName.toString(), args: invoke.args };
}

/** Decode the single invokeContract operation of an unsigned XDR. */
function decodeInvocation(unsignedXdr: string): Invocation {
  return invocationOf(TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase) as Transaction);
}

/** Exact decimal of a u64 ScVal. */
function u64Of(value: xdr.ScVal): string {
  expect(value.type).toBe("scvU64");
  return (scValToNative(value) as bigint).toString();
}

// ── Registry interface fixture ───────────────────────────────────────────────
//
// Mirrors Heliobond/contracts project_registry/src/lib.rs at b43c51a:
//   set_whitelist(account: Address, status: bool, valid_until: u64)
//   create_project(creator: Address, uri: String, maturity_date: u64,
//                  metadata_hash: BytesN<32>) -> u32
// and its whitelist check in create_project:
//   status == false                              -> NotWhitelisted
//   valid_until > 0 && ledger time > valid_until -> WhitelistExpired
const REGISTRY_SPEC: Record<string, Array<[string, string]>> = {
  set_whitelist: [
    ["account", "scvAddress"],
    ["status", "scvBool"],
    ["valid_until", "scvU64"],
  ],
  create_project: [
    ["creator", "scvAddress"],
    ["uri", "scvString"],
    ["maturity_date", "scvU64"],
    ["metadata_hash", "scvBytes"],
  ],
};

/**
 * Stateful stand-in for Soroban RPC simulation against the registry: rejects
 * invocations whose arguments do not match the contract signature (as the
 * host does), and applies the registry's whitelist/expiry rules.
 */
function registrySimulator(ledgerTimestamp: bigint) {
  const whitelist = new Map<string, { status: boolean; validUntil: bigint }>();

  /** Check one invocation against the registry interface and state. */
  function invoke({ fn, args }: Invocation): void {
    const spec = REGISTRY_SPEC[fn];
    if (!spec) throw new Error(`HostError: function ${fn} not found`);
    if (args.length !== spec.length) {
      throw new Error(
        `HostError: ${fn} expects ${spec.length} arguments, got ${args.length} (UnexpectedSize)`,
      );
    }
    spec.forEach(([name, type], i) => {
      if (args[i].type !== type) {
        throw new Error(`HostError: ${fn}.${name} expected ${type}, got ${args[i].type}`);
      }
    });

    if (fn === "set_whitelist") {
      whitelist.set(scValToNative(args[0]) as string, {
        status: scValToNative(args[1]) as boolean,
        validUntil: scValToNative(args[2]) as bigint,
      });
      return;
    }
    if ((scValToNative(args[3]) as Buffer).length !== 32) {
      throw new Error("HostError: metadata_hash must be BytesN<32>");
    }
    const entry = whitelist.get(scValToNative(args[0]) as string);
    if (!entry || !entry.status) throw new Error("Error(Contract, NotWhitelisted)");
    if (entry.validUntil > 0n && ledgerTimestamp > entry.validUntil) {
      throw new Error("Error(Contract, WhitelistExpired)");
    }
  }

  const server = {
    simulateTransaction: jest.fn(),
    prepareTransaction: jest.fn(async (tx: Transaction) => {
      invoke(invocationOf(tx));
      return tx;
    }),
    invoke,
  };
  return server as unknown as {
    simulateTransaction: (tx: Transaction) => Promise<rpc.Api.SimulateTransactionResponse>;
    prepareTransaction: (tx: Transaction) => Promise<Transaction>;
    invoke: (invocation: Invocation) => void;
  };
}

function setWhitelist(validUntil?: bigint | string): string {
  return buildSetWhitelistTx({
    contractId: CONTRACT_ID,
    sourceAccount: WHITELISTER,
    sequence: "1",
    account: WALLET_A,
    ...(validUntil !== undefined ? { validUntil } : {}),
  });
}

function createProject(maturityDate: bigint | string | number = "2000000000"): string {
  return buildCreateProjectTx({
    contractId: CONTRACT_ID,
    sourceAccount: WALLET_A,
    sequence: "2",
    creator: WALLET_A,
    uri: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    maturityDate,
    metadataHash: "e".repeat(64),
  });
}

describe("creator onboarding integrity", () => {
  let app: Express;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.WALLET_AUTH_REQUIRE_SIGNATURE = "false";
    resetCreatorApplications();
    setMetadataPinner(null);
    app = buildApp();
  });

  afterEach(() => {
    delete process.env.WALLET_AUTH_REQUIRE_SIGNATURE;
    setMetadataPinner(null);
  });

  // ── #995 ──────────────────────────────────────────────────────────────────
  describe("#995 set_whitelist valid_until", () => {
    it("serializes account, status and valid_until in contract order with correct types", () => {
      const { fn, args } = decodeInvocation(setWhitelist("1900000000"));
      expect(fn).toBe("set_whitelist");
      expect(args.map((a) => a.type)).toEqual(["scvAddress", "scvBool", "scvU64"]);
      expect(scValToNative(args[0])).toBe(WALLET_A);
      expect(scValToNative(args[1])).toBe(true);
      expect(scValToNative(args[2])).toBe(1900000000n);
    });

    it("defaults to a permanent whitelist (valid_until = 0)", () => {
      expect(PERMANENT_WHITELIST_VALID_UNTIL).toBe(0n);
      const { args } = decodeInvocation(setWhitelist());
      expect(args).toHaveLength(3);
      expect(args[2].type).toBe("scvU64");
      expect(scValToNative(args[2])).toBe(0n);
    });

    it("can revoke via status=false and accepts the u64 maximum", () => {
      const xdrStr = buildSetWhitelistTx({
        contractId: CONTRACT_ID,
        sourceAccount: WHITELISTER,
        sequence: "1",
        account: WALLET_A,
        status: false,
        validUntil: U64_MAX,
      });
      const { args } = decodeInvocation(xdrStr);
      expect(scValToNative(args[1])).toBe(false);
      expect(scValToNative(args[2])).toBe(U64_MAX);
    });

    it("rejects valid_until outside u64 or as a lossy number", () => {
      expect(() => setWhitelist((U64_MAX + 1n).toString())).toThrow(/u64/);
      expect(() => setWhitelist("-1")).toThrow(/non-negative integer/);
      expect(() =>
        buildSetWhitelistTx({
          contractId: CONTRACT_ID,
          sourceAccount: WHITELISTER,
          sequence: "1",
          account: WALLET_A,
          validUntil: 2 ** 64,
        }),
      ).toThrow(/safe integer/);
    });

    it("permanent whitelist simulates, and create_project still passes long after", async () => {
      const sim = registrySimulator(4_000_000_000n);
      await expect(prepareOnboardingTransaction(setWhitelist(), sim)).resolves.toEqual(
        expect.any(String),
      );
      await expect(prepareOnboardingTransaction(createProject(), sim)).resolves.toEqual(
        expect.any(String),
      );
    });

    it("expiring whitelist simulates; create_project passes before expiry and fails after", async () => {
      const before = registrySimulator(1_700_000_000n);
      await prepareOnboardingTransaction(setWhitelist("1800000000"), before);
      await expect(prepareOnboardingTransaction(createProject(), before)).resolves.toEqual(
        expect.any(String),
      );

      const after = registrySimulator(1_800_000_001n);
      await prepareOnboardingTransaction(setWhitelist("1800000000"), after);
      await expect(prepareOnboardingTransaction(createProject(), after)).rejects.toThrow(
        /WhitelistExpired/,
      );
    });

    it("a two-argument set_whitelist (the old shape) is rejected by the registry interface", async () => {
      const sim = registrySimulator(0n);
      const { fn, args } = decodeInvocation(setWhitelist());
      expect(() => sim.invoke({ fn, args })).not.toThrow();
      expect(() => sim.invoke({ fn, args: args.slice(0, 2) })).toThrow(
        /expects 3 arguments, got 2/,
      );
    });

    it("PATCH approval accepts whitelist_valid_until and encodes it", async () => {
      const id = await submitAs(app, WALLET_A);
      await admin(app, id, { status: "in_review" }).expect(200);
      const res = await admin(app, id, {
        status: "approved",
        whitelister: WHITELISTER,
        whitelist_valid_until: "1900000000",
      }).expect(200);
      expect(res.body.set_whitelist_valid_until).toBe("1900000000");
      const { args } = decodeInvocation(res.body.set_whitelist_tx);
      expect(scValToNative(args[0])).toBe(WALLET_A);
      expect(scValToNative(args[1])).toBe(true);
      expect(scValToNative(args[2])).toBe(1900000000n);
    });

    it("PATCH approval without whitelist_valid_until builds a permanent whitelist", async () => {
      const id = await submitAs(app, WALLET_A);
      await admin(app, id, { status: "in_review" }).expect(200);
      const res = await admin(app, id, { status: "approved", whitelister: WHITELISTER }).expect(
        200,
      );
      expect(res.body.set_whitelist_valid_until).toBe("0");
      expect(scValToNative(decodeInvocation(res.body.set_whitelist_tx).args[2])).toBe(0n);
    });

    it("PATCH rejects an invalid whitelist_valid_until with 400 and leaves the application in review", async () => {
      const id = await submitAs(app, WALLET_A);
      await admin(app, id, { status: "in_review" }).expect(200);
      await admin(app, id, {
        status: "approved",
        whitelister: WHITELISTER,
        whitelist_valid_until: "18446744073709551616",
      }).expect(400);
      await admin(app, id, {
        status: "approved",
        whitelister: WHITELISTER,
        whitelist_valid_until: "soon",
      }).expect(400);
      expect(getApplication(id)?.status).toBe("in_review");
    });
  });

  // ── #996 ──────────────────────────────────────────────────────────────────
  describe("#996 exact u64 maturity_date", () => {
    it("round-trips 9007199254740993 (above MAX_SAFE_INTEGER) without changing it", () => {
      const { args } = decodeInvocation(createProject("9007199254740993"));
      expect(args[2].type).toBe("scvU64");
      expect(u64Of(args[2])).toBe("9007199254740993");
      expect(scValToNative(args[2])).toBe(9007199254740993n);
    });

    it("accepts bigint input and the u64 maximum", () => {
      const { args } = decodeInvocation(createProject(U64_MAX));
      expect(u64Of(args[2])).toBe("18446744073709551615");
    });

    it("rejects values beyond u64 and numbers that may already be rounded", () => {
      expect(() => createProject("18446744073709551616")).toThrow(/u64/);
      expect(() => createProject(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integer/);
      expect(() => createProject(-1)).toThrow(/u64/);
    });

    describe("GET create-project-tx", () => {
      let id: string;
      beforeEach(async () => {
        id = await approveAs(app, WALLET_A);
        await request(app)
          .post(`/admin/creators/applications/${id}/confirm-whitelist`)
          .set("Authorization", `Bearer ${ADMIN_KEY}`)
          .send({})
          .expect(200);
      });

      function get(maturity: string) {
        return request(app)
          .get(
            `/creators/applications/${id}/create-project-tx?sequence=7&maturity_date=${maturity}`,
          )
          .set("x-wallet-address", WALLET_A);
      }

      it("encodes 9007199254740993 exactly and echoes it as a decimal string", async () => {
        const res = await get("9007199254740993").expect(200);
        expect(res.body.maturity_date).toBe("9007199254740993");
        const { args } = decodeInvocation(res.body.unsigned_xdr);
        expect(u64Of(args[2])).toBe("9007199254740993");
      });

      it("accepts the u64 maximum (20 digits)", async () => {
        const res = await get("18446744073709551615").expect(200);
        expect(res.body.maturity_date).toBe("18446744073709551615");
        expect(u64Of(decodeInvocation(res.body.unsigned_xdr).args[2])).toBe("18446744073709551615");
      });

      it("returns 400 for one beyond the u64 maximum", async () => {
        const res = await get("18446744073709551616").expect(400);
        expect(JSON.stringify(res.body)).toMatch(/maturity_date exceeds maximum allowed range/);
      });

      it("returns 400 for non-integer input", async () => {
        await get("1.5").expect(400);
        await get("-1").expect(400);
      });
    });
  });

  // ── #997 ──────────────────────────────────────────────────────────────────
  describe("#997 concurrent reviews", () => {
    function deferredPinner() {
      const pending: Array<{ resolve: (uri: string) => void }> = [];
      let notify: (() => void) | null = null;
      const pinner: MetadataPinner = {
        pin: () =>
          new Promise<{ uri: string }>((resolve) => {
            pending.push({ resolve: (uri) => resolve({ uri }) });
            notify?.();
          }),
      };
      const waitForPins = (n: number) =>
        new Promise<void>((resolve) => {
          const check = () => (pending.length >= n ? resolve() : undefined);
          notify = check;
          check();
        });
      return { pinner, pending, waitForPins };
    }

    async function inReview(): Promise<string> {
      const id = await submitAs(app, WALLET_A);
      await admin(app, id, { status: "in_review" }).expect(200);
      return id;
    }

    it("rejection committed while approval awaits the pinner wins; approval gets 409", async () => {
      const { pinner, pending, waitForPins } = deferredPinner();
      setMetadataPinner(pinner);
      const id = await inReview();

      const approval = admin(app, id, { status: "approved", actor: "alice" }).then((r) => r);
      await waitForPins(1);

      await admin(app, id, { status: "rejected", actor: "bob" }).expect(200);
      pending[0].resolve("ipfs://late");

      const res = await approval;
      expect(res.status).toBe(409);
      expect(res.body.error?.code ?? res.body.code).toBe("conflict");

      const app1 = getApplication(id)!;
      expect(app1.status).toBe("rejected");
      expect(app1.metadata_hash).toBeNull();
      expect(app1.metadata_uri).toBeNull();
      expect(app1.audit.map((e) => [e.from, e.to])).toEqual([
        [null, "submitted"],
        ["submitted", "in_review"],
        ["in_review", "rejected"],
      ]);
    });

    it("two approvals racing: only the first to commit pins its metadata", async () => {
      const { pinner, pending, waitForPins } = deferredPinner();
      setMetadataPinner(pinner);
      const id = await inReview();

      const first = admin(app, id, { status: "approved", actor: "alice" }).then((r) => r);
      const second = admin(app, id, { status: "approved", actor: "bob" }).then((r) => r);
      await waitForPins(2);

      pending[1].resolve("ipfs://bob");
      const bob = await second;
      pending[0].resolve("ipfs://alice");
      const alice = await first;

      expect(bob.status).toBe(200);
      expect(alice.status).toBe(409);
      const stored = getApplication(id)!;
      expect(stored.status).toBe("approved");
      expect(stored.metadata_uri).toBe("ipfs://bob");
      expect(stored.metadata_hash).toBe(computeMetadataHash(metadata).hash);
      const approvals = stored.audit.filter((e) => e.to === "approved");
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ from: "in_review", actor: "bob" });
    });

    it("an approval whose pin finishes first still blocks a later rejection", async () => {
      const id = await inReview();
      await admin(app, id, { status: "approved" }).expect(200);
      await admin(app, id, { status: "rejected" }).expect(400);
      expect(getApplication(id)?.status).toBe("approved");
    });
  });

  // ── #998 ──────────────────────────────────────────────────────────────────
  describe("#998 project linking by metadata and creator", () => {
    const hash = () => computeMetadataHash(metadata).hash;

    async function processEvent(event: Record<string, unknown>, txHash: string) {
      const client = { getTransaction: jest.fn().mockResolvedValue({ events: [event] }) };
      await (
        indexer as unknown as {
          processTransaction: (c: unknown, hash: string, ledger: number) => Promise<void>;
        }
      ).processTransaction(client, txHash, 10);
    }

    it("links identical metadata from two wallets to each creator's own application", async () => {
      const appA = await approveAs(app, WALLET_A);
      const appB = await approveAs(app, WALLET_B);
      expect(getApplication(appA)!.metadata_hash).toBe(getApplication(appB)!.metadata_hash);

      // B registers first, so a hash-only lookup would have linked A's application.
      const eventB = {
        type: "ProjectCreated",
        project_id: 7,
        owner: WALLET_B,
        metadata_hash: hash(),
      };
      const eventA = {
        type: "ProjectCreated",
        project_id: 8,
        owner: WALLET_A,
        metadata_hash: hash(),
      };
      await processEvent(eventB, "b".repeat(64));
      await processEvent(eventA, "a".repeat(64));

      expect(getApplication(appA)).toMatchObject({
        project_id: 8,
        linked_tx_hash: "a".repeat(64),
      });
      expect(getApplication(appB)).toMatchObject({
        project_id: 7,
        linked_tx_hash: "b".repeat(64),
      });

      const snapshot = (id: string) => JSON.parse(JSON.stringify(getApplication(id)));
      const beforeA = snapshot(appA);
      const beforeB = snapshot(appB);

      // Replay both events (in either order): links and audit history unchanged.
      await processEvent(eventA, "a".repeat(64));
      await processEvent(eventB, "b".repeat(64));
      await processEvent(eventA, "a".repeat(64));

      expect(snapshot(appA)).toEqual(beforeA);
      expect(snapshot(appB)).toEqual(beforeB);
      expect(
        beforeA.audit.filter((e: { note?: string }) => /Linked/.test(e.note ?? "")),
      ).toHaveLength(1);
      expect(
        beforeB.audit.filter((e: { note?: string }) => /Linked/.test(e.note ?? "")),
      ).toHaveLength(1);
    });

    it("links one creator's duplicate submissions oldest-first, one project each", async () => {
      const first = await approveAs(app, WALLET_A);
      const second = await approveAs(app, WALLET_A);
      const link = (projectId: number) =>
        linkProjectToApplication({
          metadataHash: hash(),
          creator: WALLET_A,
          projectId,
          txHash: String(projectId).repeat(64).slice(0, 64),
          ledger: 1,
        });

      expect(link(11)?.id).toBe(first);
      expect(link(12)?.id).toBe(second);
      // Replays resolve to the application already holding that project.
      expect(link(11)?.id).toBe(first);
      expect(link(12)?.id).toBe(second);
      // A third project has no unlinked application left.
      expect(link(13)).toBeNull();
      expect(getApplication(first)?.project_id).toBe(11);
      expect(getApplication(second)?.project_id).toBe(12);
    });

    it("does not link when the creator does not match or is missing", async () => {
      const id = await approveAs(app, WALLET_A);
      expect(
        linkProjectToApplication({
          metadataHash: hash(),
          creator: WALLET_B,
          projectId: 5,
          txHash: "c".repeat(64),
          ledger: 1,
        }),
      ).toBeNull();
      await processEvent(
        { type: "ProjectCreated", project_id: 5, metadata_hash: hash() },
        "d".repeat(64),
      );
      expect(getApplication(id)?.project_id).toBeNull();
    });
  });
});
