import express, { Express } from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  creatorApplicationsRouter,
  creatorAdminRouter,
  MAX_DIGIT_STRING_LENGTH,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "../routes/creatorApplications";
import {
  resetCreatorApplications,
  submitApplication,
  reviewApplication,
  buildCreateProjectTx,
  CreatorValidationError,
  CreatorApplication,
} from "../lib/creatorOnboarding";
import { errorHandler } from "../middleware/errors";

const ADMIN_KEY = "test-admin-secret-key-12345";
const CONTRACT_ID = "CCJXNKUOIHQ2DENBSMM2523UJIF7PG5JQSAT5FWWC5U2APGHBKB7MAGE";
process.env.ADMIN_API_KEY = ADMIN_KEY;

jest.mock("../config", () => {
  const actual = jest.requireActual("../config");
  return {
    config: {
      ...actual.config,
      PROJECT_REGISTRY_CONTRACT_ID: "CCJXNKUOIHQ2DENBSMM2523UJIF7PG5JQSAT5FWWC5U2APGHBKB7MAGE",
      ADMIN_API_KEY: "test-admin-secret-key-12345",
    },
  };
});

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/creators", creatorApplicationsRouter);
  app.use("/admin/creators", creatorAdminRouter);
  app.use(errorHandler);
  return app;
}

const sampleMetadata = {
  name: "Solar Array Alpha",
  location: "Sahara Desert",
  capacity_kw: 5000,
  documents: ["ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"],
};

describe("Creator Admin Pagination & Input Bounds Matrix (#890)", () => {
  let app: Express;
  let creatorWallet: string;
  let approvedAppId: string;

  beforeEach(async () => {
    resetCreatorApplications();
    app = buildApp();
    creatorWallet = Keypair.random().publicKey();

    // Create an approved application for create-project-tx testing
    const created = submitApplication(creatorWallet, sampleMetadata);
    await reviewApplication(created.id, "in_review", "admin");
    await reviewApplication(created.id, "approved", "admin");
    approvedAppId = created.id;
  });

  describe("Dimension 1: Boundaries & Clamping (create-project-tx digit string bounds)", () => {
    const longDigitStrings = [
      "12345678901234567890", // 20 chars
      "99999999999999999999", // 20 chars
      "100000000000000000000", // 21 chars
      "123456789012345678901234567890", // 30 chars
      "9".repeat(50),
      "1".repeat(100),
      "9".repeat(400), // 400-digit string mentioned in issue #890
    ];

    it.each(longDigitStrings)(
      "rejects oversized sequence string of length %d with HTTP 400",
      async (oversizedSeq) => {
        const res = await request(app)
          .get(`/creators/applications/${approvedAppId}/create-project-tx`)
          .query({ sequence: oversizedSeq, maturity_date: "1800000000" })
          .set("x-wallet-address", creatorWallet);

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe("bad_request");
        expect(res.body.error.message).toMatch(/sequence must be no longer than 19 digits/);
      },
    );

    it.each(longDigitStrings)(
      "rejects oversized maturity_date string of length %d with HTTP 400 (not 500)",
      async (oversizedMaturity) => {
        const res = await request(app)
          .get(`/creators/applications/${approvedAppId}/create-project-tx`)
          .query({ sequence: "1", maturity_date: oversizedMaturity })
          .set("x-wallet-address", creatorWallet);

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe("bad_request");
        expect(res.body.error.message).toMatch(/maturity_date must be no longer than 19 digits/);
      },
    );

    const hugeMaturityValues = [
      "18446744073709551616", // 2^64 (overflows u64)
      "9999999999999999999", // 19 digits but > Number.MAX_SAFE_INTEGER (9007199254740991)
      "9007199254740992", // MAX_SAFE_INTEGER + 1
      "9007199254740993",
    ];

    it.each(hugeMaturityValues)(
      "rejects huge maturity '%s' exceeding safe integer range with HTTP 400",
      async (hugeVal) => {
        const res = await request(app)
          .get(`/creators/applications/${approvedAppId}/create-project-tx`)
          .query({ sequence: "1", maturity_date: hugeVal })
          .set("x-wallet-address", creatorWallet);

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe("bad_request");
      },
    );

    const validDigitStrings = [
      ["0", "0"],
      ["1", "1"],
      ["42", "42"],
      ["1000", "1000"],
      ["1234567890", "1234567890"],
      ["1234567890123456789", "1234567890123456789"], // exactly 19 digits
    ];

    it.each(validDigitStrings)("accepts sequence '%s' up to 19 digits", async (validSeq) => {
      const res = await request(app)
        .get(`/creators/applications/${approvedAppId}/create-project-tx`)
        .query({ sequence: validSeq, maturity_date: "1800000000" })
        .set("x-wallet-address", creatorWallet);

      expect(res.body.error).toBeUndefined();
      expect(res.status).toBe(200);
      expect(res.body.unsigned_xdr).toBeDefined();
    });
  });

  describe("Dimension 1 (cont.): Admin Applications Pagination Bounds & Clamping", () => {
    const invalidLimits = [
      "0",
      "-1",
      "-50",
      "101",
      "150",
      "9999",
      "abc",
      "1.5",
      "NaN",
      "null",
      " ",
    ];

    it.each(invalidLimits)(
      "rejects invalid admin pagination limit '%s' with HTTP 400",
      async (badLimit) => {
        const res = await request(app)
          .get("/admin/creators/applications")
          .query({ limit: badLimit })
          .set("Authorization", `Bearer ${ADMIN_KEY}`);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("bad_request");
      },
    );

    const invalidOffsets = ["-1", "-10", "abc", "1.5", "NaN", "null", " "];

    it.each(invalidOffsets)(
      "rejects invalid admin pagination offset '%s' with HTTP 400",
      async (badOffset) => {
        const res = await request(app)
          .get("/admin/creators/applications")
          .query({ offset: badOffset })
          .set("Authorization", `Bearer ${ADMIN_KEY}`);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("bad_request");
      },
    );

    const validLimits = [1, 2, 5, 20, 50, 99, 100];

    it.each(validLimits)("accepts valid limit %d within bounds [1, 100]", async (validLimit) => {
      const res = await request(app)
        .get("/admin/creators/applications")
        .query({ limit: validLimit })
        .set("Authorization", `Bearer ${ADMIN_KEY}`);

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(validLimit);
      expect(Array.isArray(res.body.applications)).toBe(true);
      expect(res.body.applications.length).toBeLessThanOrEqual(validLimit);
    });
  });

  describe("Dimension 2: Combinatorics (Pagination slices, total & has_more flags)", () => {
    beforeEach(() => {
      resetCreatorApplications();
      // Seed 25 applications
      for (let i = 1; i <= 25; i++) {
        const wallet = Keypair.random().publicKey();
        submitApplication(wallet, {
          ...sampleMetadata,
          name: `Solar Plant #${i}`,
        });
      }
    });

    const paginationScenarios = [
      { limit: 10, offset: 0, expectedCount: 10, expectedHasMore: true, total: 25 },
      { limit: 10, offset: 10, expectedCount: 10, expectedHasMore: true, total: 25 },
      { limit: 10, offset: 20, expectedCount: 5, expectedHasMore: false, total: 25 },
      { limit: 10, offset: 25, expectedCount: 0, expectedHasMore: false, total: 25 },
      { limit: 10, offset: 30, expectedCount: 0, expectedHasMore: false, total: 25 },
      { limit: 25, offset: 0, expectedCount: 25, expectedHasMore: false, total: 25 },
      { limit: 50, offset: 0, expectedCount: 25, expectedHasMore: false, total: 25 },
      { limit: 5, offset: 0, expectedCount: 5, expectedHasMore: true, total: 25 },
      { limit: 5, offset: 20, expectedCount: 5, expectedHasMore: false, total: 25 },
    ];

    it.each(paginationScenarios)(
      "slices applications accurately for limit=$limit, offset=$offset",
      async ({ limit, offset, expectedCount, expectedHasMore, total }) => {
        const res = await request(app)
          .get("/admin/creators/applications")
          .query({ limit, offset })
          .set("Authorization", `Bearer ${ADMIN_KEY}`);

        expect(res.status).toBe(200);
        expect(res.body.total).toBe(total);
        expect(res.body.limit).toBe(limit);
        expect(res.body.offset).toBe(offset);
        expect(res.body.has_more).toBe(expectedHasMore);
        expect(res.body.applications).toHaveLength(expectedCount);

        if (expectedCount > 0) {
          expect(res.body.applications[0].metadata.name).toBe(`Solar Plant #${offset + 1}`);
        }
      },
    );

    it("defaults to limit=20 and offset=0 when unprovided", async () => {
      const res = await request(app)
        .get("/admin/creators/applications")
        .set("Authorization", `Bearer ${ADMIN_KEY}`);

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(DEFAULT_PAGE_LIMIT);
      expect(res.body.offset).toBe(0);
      expect(res.body.total).toBe(25);
      expect(res.body.has_more).toBe(true);
      expect(res.body.applications).toHaveLength(20);
    });

    it("requires admin bearer authentication", async () => {
      await request(app).get("/admin/creators/applications").expect(401);
      await request(app)
        .get("/admin/creators/applications")
        .set("Authorization", "Bearer invalid-secret")
        .expect(401);
    });
  });

  describe("Dimension 3: Host Variations & Whitelister Sequence Bounds", () => {
    it("rejects oversized whitelister_sequence (> 19 digits) on admin PATCH approval", async () => {
      const wallet = Keypair.random().publicKey();
      const appRecord = submitApplication(wallet, sampleMetadata);

      const res = await request(app)
        .patch(`/admin/creators/applications/${appRecord.id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({
          status: "approved",
          whitelister: Keypair.random().publicKey(),
          whitelister_sequence: "9".repeat(25),
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(
        /whitelister_sequence must be no longer than 19 digits/,
      );
    });

    it("accepts valid whitelister_sequence up to 19 digits on admin PATCH approval", async () => {
      const wallet = Keypair.random().publicKey();
      const appRecord = submitApplication(wallet, sampleMetadata);
      await reviewApplication(appRecord.id, "in_review", "admin");

      const res = await request(app)
        .patch(`/admin/creators/applications/${appRecord.id}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .send({
          status: "approved",
          whitelister: Keypair.random().publicKey(),
          whitelister_sequence: "1234567890123456789",
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("approved");
    });
  });

  describe("Dimension 4: Negative Controls & Domain Defense", () => {
    it("throws CreatorValidationError when buildCreateProjectTx receives non-finite maturityDate", () => {
      expect(() => {
        buildCreateProjectTx({
          contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          sourceAccount: creatorWallet,
          sequence: "1",
          creator: creatorWallet,
          uri: "ipfs://example",
          maturityDate: Infinity,
          metadataHash: "0".repeat(64),
        });
      }).toThrow(CreatorValidationError);
    });

    it("throws CreatorValidationError when buildCreateProjectTx receives negative maturityDate", () => {
      expect(() => {
        buildCreateProjectTx({
          contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          sourceAccount: creatorWallet,
          sequence: "1",
          creator: creatorWallet,
          uri: "ipfs://example",
          maturityDate: -1,
          metadataHash: "0".repeat(64),
        });
      }).toThrow(CreatorValidationError);
    });

    it("throws CreatorValidationError when buildCreateProjectTx receives sequence longer than 19 digits", () => {
      expect(() => {
        buildCreateProjectTx({
          contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          sourceAccount: creatorWallet,
          sequence: "9".repeat(25),
          creator: creatorWallet,
          uri: "ipfs://example",
          maturityDate: 1800000000,
          metadataHash: "0".repeat(64),
        });
      }).toThrow(CreatorValidationError);
    });

    it("does not mutate application state when create-project-tx fails validation", async () => {
      await request(app)
        .get(`/creators/applications/${approvedAppId}/create-project-tx`)
        .query({ sequence: "9".repeat(50), maturity_date: "1800000000" })
        .set("x-wallet-address", creatorWallet)
        .expect(400);

      const res = await request(app)
        .get(`/admin/creators/applications/${approvedAppId}`)
        .set("Authorization", `Bearer ${ADMIN_KEY}`)
        .expect(200);

      expect(res.body.status).toBe("approved");
      expect(res.body.project_id).toBeNull();
    });
  });

  describe("Dimension 5: Stress, Concurrency & High-volume pagination", () => {
    beforeEach(() => {
      resetCreatorApplications();
      // Seed 60 applications
      for (let i = 1; i <= 60; i++) {
        const wallet = Keypair.random().publicKey();
        submitApplication(wallet, {
          ...sampleMetadata,
          name: `Bulk Project #${i.toString().padStart(3, "0")}`,
        });
      }
    });

    it.each(Array.from({ length: 50 }, (_, i) => i + 1))(
      "rapid sequential pagination query #%d",
      async (i) => {
        const limit = (i % 10) + 1; // 1 to 10
        const offset = (i % 5) * 5; // 0, 5, 10, 15, 20
        const res = await request(app)
          .get("/admin/creators/applications")
          .query({ limit, offset })
          .set("Authorization", `Bearer ${ADMIN_KEY}`);

        expect(res.status).toBe(200);
        expect(res.body.total).toBe(60);
        expect(res.body.limit).toBe(limit);
        expect(res.body.offset).toBe(offset);
        expect(res.body.applications).toHaveLength(limit);
      },
    );

    it("handles 20 concurrent pagination requests with varied offsets reliably", async () => {
      const requests = Array.from({ length: 20 }, (_, idx) => {
        const offset = idx * 2;
        return request(app)
          .get("/admin/creators/applications")
          .query({ limit: 5, offset })
          .set("Authorization", `Bearer ${ADMIN_KEY}`);
      });

      const responses = await Promise.all(requests);
      responses.forEach((res, idx) => {
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(60);
        expect(res.body.offset).toBe(idx * 2);
        expect(res.body.limit).toBe(5);
        expect(res.body.applications).toHaveLength(5);
      });
    });
  });
});
