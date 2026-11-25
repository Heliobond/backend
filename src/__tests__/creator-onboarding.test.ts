import request from "supertest";
import express, { Express } from "express";
import { readFileSync } from "fs";
import { join } from "path";
import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { creatorApplicationsRouter, creatorAdminRouter } from "../routes/creatorApplications";
import { errorHandler } from "../middleware/errors";
import { walletChallenge } from "../middleware/walletAuth";
import {
  resetCreatorApplications,
  setMetadataPinner,
  reviewApplication,
  HttpMetadataPinner,
  getApplication,
  computeMetadataHash,
  canonicalMetadataBytes,
  sha256Hex,
  verifyMetadataHash,
  CreatorProjectMetadata,
  buildSetWhitelistTx,
  confirmWhitelistForApplication,
  setRegistryWhitelistChecker,
} from "../lib/creatorOnboarding";
import { setAuditSink } from "../lib/audit-logger";
import { indexer } from "../lib/indexer";
import { networkPassphrase } from "../lib/stellar";
import * as notifications from "../lib/notifications";

// A syntactically valid Soroban contract id; the real one is supplied via config.
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

const WALLET = Keypair.random().publicKey();
const WHITELISTER = Keypair.random().publicKey();

const validMetadata: CreatorProjectMetadata = {
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

function submit(app: Express, metadata: object = validMetadata) {
  return request(app).post("/creators/applications").set("x-wallet-address", WALLET).send(metadata);
}

async function approve(app: Express, id: string, extra: Record<string, unknown> = {}) {
  await request(app)
    .patch(`/admin/creators/applications/${id}`)
    .set("Authorization", `Bearer ${ADMIN_KEY}`)
    .send({ status: "in_review" })
    .expect(200);
  return request(app)
    .patch(`/admin/creators/applications/${id}`)
    .set("Authorization", `Bearer ${ADMIN_KEY}`)
    .send({ status: "approved", ...extra })
    .expect(200);
}

/**
 * A fetch-compatible transport that hangs forever unless its AbortSignal
 * fires, like a stalled pinning provider. It rejects when the signal aborts.
 */
function hangingTransport(): typeof fetch {
  return ((input: unknown, init?: RequestInit) => {
    return new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  }) as unknown as typeof fetch;
}

describe("creator onboarding pipeline (#771)", () => {
  let app: Express;
  let auditLines: string[];

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    // The creator-onboarding tests focus on the metadata + review +
    // whitelist flow, not auth. walletAuth now defaults to requiring a
    // signed wallet challenge (#832), so these tests opt out explicitly
    // to keep the per-case `submit()` helper on address-only semantics.
    // The "wallet signature option" describe below sets this back to
    // "true" to exercise the signed path.
    process.env.WALLET_AUTH_REQUIRE_SIGNATURE = "false";
    resetCreatorApplications();
    setMetadataPinner(null);
    auditLines = [];
    setAuditSink((line) => auditLines.push(line));
    app = buildApp();
    jest.clearAllMocks();
  });

  afterEach(() => {
    setAuditSink(undefined);
    delete process.env.WALLET_AUTH_REQUIRE_SIGNATURE;
  });

  describe("POST /creators/applications", () => {
    it("accepts valid metadata and creates a submitted application", async () => {
      const res = await submit(app).expect(201);
      expect(res.body).toMatchObject({
        wallet: WALLET,
        status: "submitted",
        metadata: validMetadata,
        metadata_hash: null,
        metadata_uri: null,
        project_id: null,
      });
      expect(res.body.id).toEqual(expect.any(String));
      expect(res.body.audit).toHaveLength(1);
    });

    it("requires wallet authentication", async () => {
      await request(app).post("/creators/applications").send(validMetadata).expect(401);
      await request(app)
        .post("/creators/applications")
        .set("x-wallet-address", "not-a-stellar-address")
        .send(validMetadata)
        .expect(401);
    });

    it.each([
      ["http", "http://example.com/doc.pdf"],
      ["ftp", "ftp://example.com/doc.pdf"],
      ["data", "data:text/plain;base64,aGk="],
      ["javascript", "javascript:alert(1)"],
      ["scheme-less", "example.com/doc.pdf"],
      ["empty ipfs id", "ipfs://"],
    ])("rejects a %s document URI before any on-chain work (400)", async (_label, uri) => {
      const pinSpy = jest.fn();
      setMetadataPinner({ pin: pinSpy });
      const res = await submit(app, { ...validMetadata, documents: [uri] }).expect(400);
      expect(res.body.error.code).toBe("bad_request");
      expect(pinSpy).not.toHaveBeenCalled();
    });

    it("rejects malformed required fields", async () => {
      await submit(app, { ...validMetadata, name: "" }).expect(400);
      await submit(app, { ...validMetadata, location: "" }).expect(400);
      await submit(app, { ...validMetadata, capacity_kw: 0 }).expect(400);
      await submit(app, { ...validMetadata, capacity_kw: "250" }).expect(400);
      await submit(app, { ...validMetadata, documents: [] }).expect(400);
    });

    it("accepts every allowed URI scheme", async () => {
      for (const uri of [
        "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
        "https://example.com/docs/report.pdf",
        "ar://s8LjBz1KWMnGRhBIz8RGZ1sHk9vNGnZbYu_k5QVgFyE",
      ]) {
        const res = await submit(app, { ...validMetadata, documents: [uri] }).expect(201);
        expect(res.body.metadata.documents).toEqual([uri]);
      }
    });
  });

  describe("review workflow", () => {
    it("enforces submitted → in_review → approved and audits each change", async () => {
      const created = (await submit(app).expect(201)).body;
      const id = created.id;

      await request(app)
        .patch(`/admin/creators/applications/${id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "approved" })
        .expect(400); // cannot skip review

      const inReview = await request(app)
        .patch(`/admin/creators/applications/${id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "in_review" })
        .expect(200);
      expect(inReview.body.status).toBe("in_review");

      const approved = await request(app)
        .patch(`/admin/creators/applications/${id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "approved" })
        .expect(200);
      expect(approved.body.status).toBe("approved");
      expect(approved.body.metadata_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(approved.body.metadata_uri).toEqual(expect.any(String));
      expect(approved.body.audit.map((a: { to: string }) => a.to)).toEqual([
        "submitted",
        "in_review",
        "approved",
      ]);

      const actions = auditLines.map((l) => JSON.parse(l).action);
      expect(actions).toEqual([
        "creator.application.submitted",
        "creator.application.reviewed",
        "creator.application.reviewed",
      ]);

      await request(app)
        .patch(`/admin/creators/applications/${id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "rejected" })
        .expect(400); // approved is terminal
    });

    it("notifies the wallet on every state change", async () => {
      const notifySpy = jest.spyOn(notifications, "notify");
      const created = (await submit(app).expect(201)).body;
      await request(app)
        .patch(`/admin/creators/applications/${created.id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "in_review" })
        .expect(200);
      await request(app)
        .patch(`/admin/creators/applications/${created.id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "approved" })
        .expect(200);

      const statuses = notifySpy.mock.calls.map(([event]) => String(event.data.status));
      expect(statuses).toEqual(["submitted", "in_review", "approved"]);
      notifySpy.mockRestore();
    });

    it("requires admin authentication", async () => {
      const created = (await submit(app).expect(201)).body;
      await request(app).get(`/admin/creators/applications/${created.id}`).expect(401);
      await request(app)
        .patch(`/admin/creators/applications/${created.id}`)
        .send({ status: "in_review" })
        .expect(401);
    });
  });

  describe("metadata hash + pinning", () => {
    it("hashes the exact pinned bytes and passes verify_metadata_hash", async () => {
      const captured: { bytes: Buffer | null } = { bytes: null };
      setMetadataPinner({
        pin: async (bytes: Buffer) => {
          captured.bytes = bytes;
          return { uri: "ipfs://pinned-example" };
        },
      });

      const created = (await submit(app).expect(201)).body;
      const approved = await approve(app, created.id);

      const pinned = captured.bytes;
      if (!Buffer.isBuffer(pinned)) throw new Error("metadata was not pinned");
      const bytes = pinned;
      const expected = computeMetadataHash(validMetadata);
      expect(bytes.equals(expected.bytes)).toBe(true);
      expect(approved.body.metadata_hash).toBe(sha256Hex(bytes));
      expect(approved.body.metadata_hash).toBe(expected.hash);
      expect(verifyMetadataHash(bytes, approved.body.metadata_hash)).toBe(true);
      expect(approved.body.metadata_uri).toBe("ipfs://pinned-example");
    });

    it("produces a stable hash regardless of metadata key order", () => {
      const reordered = {
        documents: validMetadata.documents,
        capacity_kw: validMetadata.capacity_kw,
        location: validMetadata.location,
        name: validMetadata.name,
      };
      expect(sha256Hex(canonicalMetadataBytes(reordered))).toBe(
        sha256Hex(canonicalMetadataBytes(validMetadata)),
      );
    });

    it("does not persist any secret key material", async () => {
      const created = (await submit(app).expect(201)).body;
      const serialized = JSON.stringify(created);
      expect(serialized).not.toMatch(/\bS[A-Z2-7]{55}\b/);
      const stored = JSON.stringify(getApplication(created.id));
      expect(stored).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    });
  });

  describe("provider metadata URI validation (#1000)", () => {
    async function moveToReview(app: Express, id: string) {
      await request(app)
        .patch(`/admin/creators/applications/${id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "in_review" })
        .expect(200);
    }

    it.each([
      ["malformed (no scheme)", "not-a-uri"],
      ["unsupported scheme", "ftp://example.com/metadata.json"],
      ["oversized", `ipfs://${"a".repeat(2048)}`],
      ["https with credentials", "https://user:pass@example.com/metadata.json"],
      ["empty ipfs id", "ipfs://"],
    ])(
      "leaves the application in_review when the provider returns a %s URI",
      async (_label, uri) => {
        setMetadataPinner({ pin: async () => ({ uri }) });
        const created = (await submit(app).expect(201)).body;
        await moveToReview(app, created.id);

        const res = await request(app)
          .patch(`/admin/creators/applications/${created.id}`)
          .set("Authorization", `Bearer ${ADMIN_KEY}`)
          .send({ status: "approved" })
          .expect(400);
        expect(res.body.error.code).toBe("bad_request");

        const stored = getApplication(created.id);
        expect(stored?.status).toBe("in_review");
        expect(stored?.metadata_hash).toBeNull();
        expect(stored?.metadata_uri).toBeNull();
        expect(stored?.audit).toHaveLength(2);
      },
    );

    it("stores a valid provider URI unchanged and builds a compatible create_project tx", async () => {
      const uri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
      setMetadataPinner({ pin: async () => ({ uri }) });
      const created = (await submit(app).expect(201)).body;
      const approved = await approve(app, created.id);
      expect(approved.body.metadata_uri).toBe(uri);

      confirmWhitelistForApplication(created.id, { txHash: "tx-mock-whitelist" });
      const res = await request(app)
        .get(
          `/creators/applications/${created.id}/create-project-tx?sequence=7&maturity_date=2000000000`,
        )
        .set("x-wallet-address", WALLET)
        .expect(200);
      expect(res.body.metadata_uri).toBe(uri);
      const tx = TransactionBuilder.fromXDR(res.body.unsigned_xdr, networkPassphrase);
      expect(tx.signatures).toHaveLength(0);
    });
  });

  describe("metadata pinning deadline and cancellation (#1001)", () => {
    it("HttpMetadataPinner times out a stalled transport with a retryable error", async () => {
      const pinner = new HttpMetadataPinner("https://pin.example.com", hangingTransport(), 50);
      await expect(pinner.pin(Buffer.from("hello"))).rejects.toMatchObject({
        code: "metadata_pinning_timeout",
      });
    });

    it("HttpMetadataPinner rejects an already-aborted request", async () => {
      const controller = new AbortController();
      controller.abort();
      const pinner = new HttpMetadataPinner("https://pin.example.com", hangingTransport());
      await expect(
        pinner.pin(Buffer.from("hello"), { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "metadata_pinning_aborted" });
    });

    it("a timed-out pin leaves the application in_review with nothing committed", async () => {
      setMetadataPinner(new HttpMetadataPinner("https://pin.example.com", hangingTransport(), 50));
      const created = (await submit(app).expect(201)).body;
      await request(app)
        .patch(`/admin/creators/applications/${created.id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "in_review" })
        .expect(200);
      await expect(reviewApplication(created.id, "approved", "admin")).rejects.toMatchObject({
        code: "metadata_pinning_timeout",
      });
      const stored = getApplication(created.id);
      expect(stored?.status).toBe("in_review");
      expect(stored?.metadata_hash).toBeNull();
      expect(stored?.metadata_uri).toBeNull();
      expect(stored?.audit).toHaveLength(2);
    });

    it("a cancelled pin leaves the application in_review with nothing committed", async () => {
      setMetadataPinner(new HttpMetadataPinner("https://pin.example.com", hangingTransport()));
      const created = (await submit(app).expect(201)).body;
      await request(app)
        .patch(`/admin/creators/applications/${created.id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "in_review" })
        .expect(200);
      const controller = new AbortController();
      const pending = reviewApplication(created.id, "approved", "admin", undefined, {
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "metadata_pinning_aborted" });
      const stored = getApplication(created.id);
      expect(stored?.status).toBe("in_review");
      expect(stored?.metadata_hash).toBeNull();
      expect(stored?.metadata_uri).toBeNull();
      expect(stored?.audit).toHaveLength(2);
    });
  });

  describe("GET /creators/applications/:id/create-project-tx", () => {
    it("is only available for an approved application", async () => {
      const created = (await submit(app).expect(201)).body;
      await request(app)
        .get(`/creators/applications/${created.id}/create-project-tx`)
        .set("x-wallet-address", WALLET)
        .expect(409);
    });

    it("returns an unsigned create_project XDR for the creator's wallet", async () => {
      const created = (await submit(app).expect(201)).body;
      const approved = await approve(app, created.id);
      confirmWhitelistForApplication(created.id, { txHash: "tx-mock-whitelist" });

      const res = await request(app)
        .get(
          `/creators/applications/${created.id}/create-project-tx?sequence=7&maturity_date=2000000000`,
        )
        .set("x-wallet-address", WALLET)
        .expect(200);

      expect(res.body.signed).toBe(false);
      expect(res.body.metadata_hash).toBe(approved.body.metadata_hash);
      expect(res.body.metadata_uri).toBe(approved.body.metadata_uri);

      const tx = TransactionBuilder.fromXDR(res.body.unsigned_xdr, networkPassphrase);
      expect(tx.signatures).toHaveLength(0);
    });

    it("rejects project tx build if approved but whitelist is not yet confirmed (409)", async () => {
      const created = (await submit(app).expect(201)).body;
      const approved = await approve(app, created.id);
      expect(approved.body.status).toBe("approved");
      expect(approved.body.whitelist_confirmed).toBe(false);
      expect(approved.body.ready_for_registration).toBe(false);

      const res = await request(app)
        .get(
          `/creators/applications/${created.id}/create-project-tx?sequence=7&maturity_date=2000000000`,
        )
        .set("x-wallet-address", WALLET)
        .expect(409);

      expect(res.body.error.message).toContain("not yet confirmed on-chain as whitelisted");
    });

    it("rejects a wallet that does not own the application", async () => {
      const created = (await submit(app).expect(201)).body;
      await approve(app, created.id);
      confirmWhitelistForApplication(created.id);
      const other = Keypair.random().publicKey();
      await request(app)
        .get(`/creators/applications/${created.id}/create-project-tx`)
        .set("x-wallet-address", other)
        .expect(403);
    });
  });

  describe("whitelist confirmation and registration readiness (#1004)", () => {
    it("approval without confirmed whitelisting reports ready_for_registration=false", async () => {
      const created = (await submit(app).expect(201)).body;
      const approved = await approve(app, created.id, {
        whitelister: WHITELISTER,
        whitelister_sequence: "3",
      });

      expect(approved.body.status).toBe("approved");
      expect(approved.body.whitelist_status).toBe("unconfirmed");
      expect(approved.body.whitelist_confirmed).toBe(false);
      expect(approved.body.ready_for_registration).toBe(false);
      expect(typeof approved.body.set_whitelist_tx).toBe("string");

      // Observable via creator GET /creators/applications/:id
      const creatorView = await request(app)
        .get(`/creators/applications/${created.id}`)
        .set("x-wallet-address", WALLET)
        .expect(200);
      expect(creatorView.body.ready_for_registration).toBe(false);
      expect(creatorView.body.whitelist_confirmed).toBe(false);
    });

    it("confirmation makes registration readiness observable without requiring second review", async () => {
      const created = (await submit(app).expect(201)).body;
      await approve(app, created.id);

      // Confirm whitelist via admin confirm endpoint
      const confirmed = await request(app)
        .post(`/admin/creators/applications/${created.id}/confirm-whitelist`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ tx_hash: "mock-tx-hash-1", actor: "admin_whitelister" })
        .expect(200);

      expect(confirmed.body.status).toBe("approved"); // status unchanged, no re-review needed
      expect(confirmed.body.whitelist_status).toBe("confirmed");
      expect(confirmed.body.whitelist_confirmed).toBe(true);
      expect(confirmed.body.ready_for_registration).toBe(true);
      expect(confirmed.body.whitelist_tx_hash).toBe("mock-tx-hash-1");

      // Verify creator can now fetch create-project-tx
      const txRes = await request(app)
        .get(
          `/creators/applications/${created.id}/create-project-tx?sequence=7&maturity_date=2000000000`,
        )
        .set("x-wallet-address", WALLET)
        .expect(200);
      expect(txRes.body.signed).toBe(false);
    });

    it("reconciles whitelist readiness via confirmed indexer event", async () => {
      const created = (await submit(app).expect(201)).body;
      await approve(app, created.id);

      const tx = {
        source: WHITELISTER,
        events: [{ type: "CreatorWhitelisted", account: WALLET, whitelisted: true }],
      };
      const client = { getTransaction: jest.fn().mockResolvedValue(tx) };

      await (
        indexer as unknown as {
          processTransaction: (c: unknown, hash: string, ledger: number) => Promise<void>;
        }
      ).processTransaction(client, "b".repeat(64), 6);

      const updated = getApplication(created.id);
      expect(updated?.whitelist_confirmed).toBe(true);
      expect(updated?.ready_for_registration).toBe(true);
      expect(updated?.whitelist_tx_hash).toBe("b".repeat(64));
    });

    it("reconciles whitelist readiness via on-chain registry state checker", async () => {
      const created = (await submit(app).expect(201)).body;
      await approve(app, created.id);

      // Set mock registry checker returning true
      setRegistryWhitelistChecker(async (contractId, wallet) => {
        expect(contractId).toBe(CONTRACT_ID);
        expect(wallet).toBe(WALLET);
        return true;
      });

      const res = await request(app)
        .post(`/creators/applications/${created.id}/reconcile-whitelist`)
        .set("x-wallet-address", WALLET)
        .expect(200);

      expect(res.body.whitelist_confirmed).toBe(true);
      expect(res.body.ready_for_registration).toBe(true);
    });
  });

  describe("unsigned XDR builders", () => {
    it("builds an unsigned set_whitelist transaction and returns it on approval", async () => {
      const created = (await submit(app).expect(201)).body;
      const approved = await approve(app, created.id, {
        whitelister: WHITELISTER,
        whitelister_sequence: "3",
      });

      expect(typeof approved.body.set_whitelist_tx).toBe("string");
      const tx = TransactionBuilder.fromXDR(approved.body.set_whitelist_tx, networkPassphrase);
      expect(tx.signatures).toHaveLength(0);
      if (!(tx instanceof Transaction)) throw new Error("expected a plain transaction");
      expect(tx.source).toBe(WHITELISTER);
    });

    it("rejects an invalid whitelister address", async () => {
      const created = (await submit(app).expect(201)).body;
      await request(app)
        .patch(`/admin/creators/applications/${created.id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "in_review" })
        .expect(200);
      await request(app)
        .patch(`/admin/creators/applications/${created.id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({ status: "approved", whitelister: "not-valid" })
        .expect(400);
    });

    it("exposes a builder that never signs", () => {
      const xdr = buildSetWhitelistTx({
        contractId: CONTRACT_ID,
        sourceAccount: WHITELISTER,
        sequence: "0",
        account: WALLET,
      });
      const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      expect(tx.signatures).toHaveLength(0);
    });
  });

  describe("indexer linking", () => {
    it("links a confirmed ProjectCreated event to the application", async () => {
      const created = (await submit(app).expect(201)).body;
      const approved = await approve(app, created.id);
      const hash = approved.body.metadata_hash as string;

      const tx = {
        source: WALLET,
        events: [{ type: "ProjectCreated", project_id: 42, owner: WALLET, metadata_hash: hash }],
      };
      const client = { getTransaction: jest.fn().mockResolvedValue(tx) };

      await (
        indexer as unknown as {
          processTransaction: (c: unknown, hash: string, ledger: number) => Promise<void>;
        }
      ).processTransaction(client, "a".repeat(64), 5);

      const linked = getApplication(created.id);
      expect(linked?.project_id).toBe(42);
      expect(linked?.linked_tx_hash).toBe("a".repeat(64));
    });
  });

  describe("wallet signature option", () => {
    it("requires a valid signature when WALLET_AUTH_REQUIRE_SIGNATURE=true", async () => {
      process.env.WALLET_AUTH_REQUIRE_SIGNATURE = "true";
      const keypair = Keypair.random();
      const timestamp = Date.now().toString();
      const challenge = walletChallenge(timestamp, "POST", "/creators/applications", validMetadata);
      const signature = Buffer.from(keypair.sign(Buffer.from(challenge, "utf8"))).toString(
        "base64",
      );

      await request(app)
        .post("/creators/applications")
        .set("x-wallet-address", keypair.publicKey())
        .send(validMetadata)
        .expect(401);

      await request(app)
        .post("/creators/applications")
        .set("x-wallet-address", keypair.publicKey())
        .set("x-wallet-signature", signature)
        .set("x-wallet-timestamp", timestamp)
        .send(validMetadata)
        .expect(201);
    });
  });

  describe("published schema", () => {
    it("src/schemas/creator-application.schema.json is valid and lists allowed URI schemes", () => {
      const schema = JSON.parse(
        readFileSync(join(__dirname, "..", "schemas", "creator-application.schema.json"), "utf8"),
      );
      expect(schema.required).toEqual(["name", "location", "capacity_kw", "documents"]);
      expect(schema.properties.documents.items.pattern).toContain("ipfs://");
      expect(schema.properties.documents.items.pattern).toContain("https://");
      expect(schema.properties.documents.items.pattern).toContain("ar://");
    });
  });
});
