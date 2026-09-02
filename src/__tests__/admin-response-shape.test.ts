import request from "supertest";
import express, { Express } from "express";
import adminRouter from "../routes/admin";
import { errorHandler } from "../middleware/errors";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import { resetIdempotencyState } from "../lib/scoreService";

jest.mock("../lib/registry", () => ({
  updateImpactScore: jest.fn(),
  getTotalProjects: jest.fn(),
}));
jest.mock("../routes/iot");
jest.mock("../lib/scoring");

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use(errorHandler);
  return app;
}

const authHeader = { Authorization: "Bearer test-key" };

describe("admin /update-scores response shape", () => {
  let app: Express;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = "test-key";
    resetIdempotencyState();
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

  it("response has updated field (number)", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({})
      .expect(200);
    expect(res.body).toHaveProperty("updated");
    expect(typeof res.body.updated).toBe("number");
  });

  it("response has results field (array)", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({})
      .expect(200);
    expect(res.body).toHaveProperty("results");
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it("response has errors field (array)", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({})
      .expect(200);
    expect(res.body).toHaveProperty("errors");
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it("response shape matches { updated, results, errors }", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({})
      .expect(200);
    expect(
      Object.keys(res.body)
        .filter((k) => k !== "skipped")
        .sort(),
    ).toEqual(["errors", "results", "updated"]);
  });

  it("results entries have correct shape", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({})
      .expect(200);
    for (const entry of res.body.results) {
      expect(entry).toHaveProperty("project_id");
      expect(entry).toHaveProperty("tx_hash");
      expect(entry).toHaveProperty("credit_quality");
      expect(entry).toHaveProperty("green_impact");
      expect(typeof entry.project_id).toBe("number");
      expect(typeof entry.tx_hash).toBe("string");
      expect(typeof entry.credit_quality).toBe("number");
      expect(typeof entry.green_impact).toBe("number");
    }
  });

  it("errors entries have correct shape", async () => {
    (registry.updateImpactScore as jest.Mock)
      .mockResolvedValueOnce("tx-hash-1")
      .mockRejectedValueOnce(new Error("RPC error"));
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(authHeader)
      .send({ project_ids: [1, 2] })
      .expect(200);
    expect(res.body.errors).toHaveLength(1);
    const entry = res.body.errors[0];
    expect(entry).toHaveProperty("project_id");
    expect(entry).toHaveProperty("error");
    expect(typeof entry.project_id).toBe("number");
    expect(typeof entry.error).toBe("object");
  });
});
