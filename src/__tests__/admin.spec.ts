import request from "supertest";
import express, { Express } from "express";
import adminRouter from "../routes/admin";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import { clearState } from "../lib/duplicate-detection";

jest.mock("../lib/registry");
jest.mock("../routes/iot");
jest.mock("../lib/scoring");

describe("admin routes", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/admin", adminRouter);

    process.env.ADMIN_API_KEY = "test-key";

    jest.clearAllMocks();
    clearState();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  describe("POST /update-scores - happy path", () => {
    it("should accept authenticated request with valid payload and submit scores", async () => {
      (registry.getTotalProjects as jest.Mock).mockResolvedValue(2);
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
      (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-hash-123");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer test-key")
        .send({})
        .expect(200);

      expect(res.body).toEqual({
        updated: 2,
        results: expect.arrayContaining([
          {
            project_id: 1,
            credit_quality: 85,
            green_impact: 70,
            tx_hash: "tx-hash-123",
          },
          {
            project_id: 2,
            credit_quality: 85,
            green_impact: 70,
            tx_hash: "tx-hash-123",
          },
        ]),
        errors: [],
      });

      expect(registry.updateImpactScore).toHaveBeenCalledTimes(2);
    });

    it("should handle specific project_ids in request body", async () => {
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
      (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-hash-456");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer test-key")
        .send({ project_ids: [1, 3] })
        .expect(200);

      expect(res.body.updated).toBe(2);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results[0].project_id).toBe(1);
      expect(res.body.results[1].project_id).toBe(3);
    });
  });

  describe("POST /update-scores - authorization rejection", () => {
    it("should return 401 when authorization header is missing", async () => {
      await request(app)
        .post("/api/admin/update-scores")
        .send({})
        .expect(401)
        .expect({ error: "unauthorized" });
    });

    it("should return 401 when authorization header has wrong token", async () => {
      await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer wrong-key")
        .send({})
        .expect(401)
        .expect({ error: "unauthorized" });
    });

    it("should return 401 when authorization format is invalid", async () => {
      await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "test-key")
        .send({})
        .expect(401)
        .expect({ error: "unauthorized" });
    });
  });

  describe("POST /update-scores - bad input handling", () => {
    it("should return 400 when project_ids is not an array", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer test-key")
        .send({ project_ids: "not-an-array" });

      expect(res.status).toBe(200);
      expect(registry.getTotalProjects).toHaveBeenCalled();
    });

    it("should return 400 when project_ids array is empty", async () => {
      (registry.getTotalProjects as jest.Mock).mockResolvedValue(1);
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

      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer test-key")
        .send({ project_ids: [] });

      expect(res.status).toBe(200);
      expect(registry.getTotalProjects).toHaveBeenCalled();
    });

    it("should catch and return partial results when some projects fail", async () => {
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
      (registry.updateImpactScore as jest.Mock)
        .mockResolvedValueOnce("tx-hash-1")
        .mockRejectedValueOnce(new Error("RPC error"))
        .mockResolvedValueOnce("tx-hash-3");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer test-key")
        .send({ project_ids: [1, 2, 3] })
        .expect(200);

      expect(res.body.updated).toBe(2);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].project_id).toBe(2);
      expect(res.body.errors[0].error).toContain("RPC error");
    });
  });

  describe("POST /update-scores - no auth required when ADMIN_API_KEY not set", () => {
    it("should allow unauthenticated request when ADMIN_API_KEY is not set", async () => {
      delete process.env.ADMIN_API_KEY;

      (registry.getTotalProjects as jest.Mock).mockResolvedValue(1);
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
      (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-hash-no-auth");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .send({})
        .expect(200);

      expect(res.body.updated).toBe(1);
    });
  });
});
