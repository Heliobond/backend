import request from "supertest";
import express, { Express } from "express";
import adminRouter from "../routes/admin";
import { errorHandler } from "../middleware/errors";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";

jest.mock("../lib/registry", () => {
  class RpcDegradedError extends Error {
    constructor(message?: string) {
      super(message ?? "RPC is degraded");
      this.name = "RpcDegradedError";
    }
  }
  return {
    updateImpactScore: jest.fn(),
    getTotalProjects: jest.fn(),
    RpcDegradedError,
  };
});
jest.mock("../routes/iot");
jest.mock("../lib/scoring");
jest.mock("../config", () => ({
  config: {
    ADMIN_API_KEY: "test-key",
  },
}));

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use(errorHandler);
  return app;
}

const AUTH_HEADER = { Authorization: "Bearer test-key" };

describe("admin routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    (iot.getSolarData as jest.Mock).mockReturnValue({
      efficiency_pct: 85,
      power_output_kw: 500,
      max_power_kw: 1000,
    });
    (iot.getSatelliteData as jest.Mock).mockReturnValue({
      forest_density_pct: 60,
      ndvi_score: 0.6,
    });
    (scoring.computeScores as jest.Mock).mockReturnValue({
      credit_quality: 85,
      green_impact: 70,
    });
    (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-hash");
    (registry.getTotalProjects as jest.Mock).mockResolvedValue(2);
  });

  // ── Auth middleware ──────────────────────────────────────────────────────

  describe("auth middleware", () => {
    it("returns 500 when ADMIN_API_KEY is not configured", async () => {
      const configModule = jest.requireMock("../config") as { config: { ADMIN_API_KEY: string } };
      const orig = configModule.config.ADMIN_API_KEY;
      configModule.config.ADMIN_API_KEY = "";
      try {
        const res = await request(app).post("/api/admin/update-scores").send({});
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe("server_misconfigured");
      } finally {
        configModule.config.ADMIN_API_KEY = orig;
      }
    });

    it("returns 401 when authorization header is missing", async () => {
      const res = await request(app).post("/api/admin/update-scores").send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    });

    it("returns 401 when bearer token is wrong", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer wrong-token")
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    });

    it("returns 401 when authorization format is invalid", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "not-bearer")
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    });

    it("passes through for valid token", async () => {
      const res = await request(app).post("/api/admin/update-scores").set(AUTH_HEADER).send({});
      expect(res.status).toBe(200);
    });
  });

  // ── POST /update-scores ──────────────────────────────────────────────────

  describe("POST /update-scores", () => {
    it("returns correct response shape with valid project_ids", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(AUTH_HEADER)
        .send({ project_ids: [1, 2] })
        .expect(200);

      expect(res.body).toMatchObject({
        updated: 2,
        results: expect.arrayContaining([
          expect.objectContaining({
            project_id: 1,
            credit_quality: 85,
            green_impact: 70,
            tx_hash: "tx-hash",
          }),
        ]),
        errors: [],
        skipped: [],
      });
    });

    it("returns 400 with invalid project_ids", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(AUTH_HEADER)
        .send({ project_ids: ["abc", null, {}] })
        .expect(400);

      expect(res.body.error.code).toBe("bad_request");
      expect(res.body.error.message).toContain("project_ids");
    });

    it("returns 400 for non-array project_ids", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(AUTH_HEADER)
        .send({ project_ids: "not-an-array" })
        .expect(400);

      expect(res.body.error.code).toBe("bad_request");
    });

    it("defaults to all projects when project_ids is omitted", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(AUTH_HEADER)
        .send({})
        .expect(200);

      expect(res.body.updated).toBe(2);
      expect(registry.getTotalProjects).toHaveBeenCalled();
    });

    it("defaults to all projects when project_ids is empty", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(AUTH_HEADER)
        .send({ project_ids: [] })
        .expect(200);

      expect(res.body.updated).toBe(2);
      expect(registry.getTotalProjects).toHaveBeenCalled();
    });

    it("defaults to all projects when project_ids is null", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(AUTH_HEADER)
        .send({ project_ids: null })
        .expect(200);

      expect(res.body.updated).toBe(2);
      expect(registry.getTotalProjects).toHaveBeenCalled();
    });

    it("defers score when RPC is degraded", async () => {
      const RpcDegradedError = (
        registry as unknown as { RpcDegradedError: new (msg?: string) => Error }
      ).RpcDegradedError;
      (registry.updateImpactScore as jest.Mock)
        .mockResolvedValueOnce("tx-1")
        .mockRejectedValueOnce(new RpcDegradedError("RPC is degraded"))
        .mockResolvedValueOnce("tx-3");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(AUTH_HEADER)
        .send({ project_ids: [1, 2, 3] })
        .expect(200);

      expect(res.body.updated).toBe(3);
      expect(res.body.results).toHaveLength(3);
      expect(res.body.errors).toHaveLength(0);
      // Project 2 should be deferred
      const deferredResult = res.body.results.find(
        (r: { project_id: number; tx_hash: string }) => r.project_id === 2,
      );
      expect(deferredResult.tx_hash).toBe("deferred");
    });

    it("isolates per-project errors without aborting the batch", async () => {
      (registry.updateImpactScore as jest.Mock)
        .mockResolvedValueOnce("tx-1")
        .mockRejectedValueOnce(new Error("RPC timeout"))
        .mockResolvedValueOnce("tx-3");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(AUTH_HEADER)
        .send({ project_ids: [1, 2, 3] })
        .expect(200);

      expect(res.body.updated).toBe(2);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0]).toMatchObject({
        project_id: 2,
        error: { code: "update_failed", message: expect.stringContaining("RPC timeout") },
      });
    });

    it("isolates a single failing project: only the failing id appears in errors, the rest in results", async () => {
      (registry.updateImpactScore as jest.Mock)
        .mockResolvedValueOnce("tx-1")
        .mockRejectedValueOnce(new Error("project 2 blew up"))
        .mockResolvedValueOnce("tx-3");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(AUTH_HEADER)
        .send({ project_ids: [1, 2, 3] })
        .expect(200);

      const resultIds = res.body.results.map((r: { project_id: number }) => r.project_id).sort();
      const errorIds = res.body.errors.map((e: { project_id: number }) => e.project_id).sort();

      expect(resultIds).toEqual([1, 3]);
      expect(errorIds).toEqual([2]);
      expect(res.body.updated).toBe(res.body.results.length);
      expect(res.body.updated).toBe(2);
    });

    it("returns 400 for negative project IDs", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(AUTH_HEADER)
        .send({ project_ids: [-1, 0] })
        .expect(400);

      expect(res.body.error.code).toBe("bad_request");
    });
  });

  // ── GET /audit ───────────────────────────────────────────────────────────

  describe("GET /audit", () => {
    it("returns audit entries", async () => {
      const res = await request(app).get("/api/admin/audit").set(AUTH_HEADER).expect(200);

      expect(res.body).toHaveProperty("count");
      expect(res.body).toHaveProperty("entries");
      expect(Array.isArray(res.body.entries)).toBe(true);
    });

    it("returns 400 when from > to", async () => {
      const res = await request(app)
        .get("/api/admin/audit")
        .set(AUTH_HEADER)
        .query({ from: "2000", to: "1000" })
        .expect(400);

      expect(res.body.error.code).toBe("bad_request");
      expect(res.body.error.message).toContain("from must be earlier than to");
    });
  });
});
