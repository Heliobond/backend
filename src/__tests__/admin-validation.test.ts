import request from "supertest";
import express, { Express } from "express";
import adminRouter from "../routes/admin";
import { errorHandler } from "../middleware/errors";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import { clearState } from "../lib/duplicate-detection";

// Factory mock avoids loading the real registry module, which throws at import
// time when PROJECT_REGISTRY_CONTRACT_ID is unset (e.g. in CI).
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

describe("admin /update-scores input validation", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    clearState();
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

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it("returns 400 { error, message } when project_ids is not an array", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .send({ project_ids: "not-an-array" })
      .expect(400);

    expect(res.body).toEqual({
      error: "bad_request",
      message: expect.stringContaining("array of positive integers"),
    });
    expect(registry.getTotalProjects).not.toHaveBeenCalled();
  });

  it("returns 400 when project_ids contains non-positive integers", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .send({ project_ids: [1, -2, 3] })
      .expect(400);

    expect(res.body.error).toBe("bad_request");
  });

  it("returns 400 when project_ids contains non-integers", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .send({ project_ids: [1, 2.5] })
      .expect(400);

    expect(res.body.error).toBe("bad_request");
  });

  it("defaults to all projects when project_ids is omitted", async () => {
    const res = await request(app).post("/api/admin/update-scores").send({}).expect(200);
    expect(res.body.updated).toBe(2);
    expect(registry.getTotalProjects).toHaveBeenCalled();
  });

  it("defaults to all projects when project_ids is an empty array", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .send({ project_ids: [] })
      .expect(200);
    expect(res.body.updated).toBe(2);
    expect(registry.getTotalProjects).toHaveBeenCalled();
  });

  it("accepts an explicit list of valid project ids", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .send({ project_ids: [1, 3] })
      .expect(200);
    expect(res.body.updated).toBe(2);
    expect(registry.getTotalProjects).not.toHaveBeenCalled();
  });

  it("returns 400 with a structured error for a malformed JSON body", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set("Content-Type", "application/json")
      .send('{ "project_ids": ')
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("rejects unauthorized requests with 401 { error, message }", async () => {
    process.env.ADMIN_API_KEY = "secret";
    const res = await request(app).post("/api/admin/update-scores").send({}).expect(401);
    expect(res.body).toEqual({
      error: "unauthorized",
      message: expect.any(String),
    });
  });
});
