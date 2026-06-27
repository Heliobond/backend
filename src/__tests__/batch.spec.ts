import request from "supertest";
import express, { Express } from "express";
import batchRouter from "../routes/batch";
import { errorHandler } from "../middleware/errors";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";

jest.mock("../lib/registry");
jest.mock("../routes/iot");
jest.mock("../lib/scoring");
jest.mock("../lib/history", () => ({ recordScoreHistory: jest.fn() }));
jest.mock("../lib/webhooks", () => ({ triggerWebhooks: jest.fn() }));

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/batch", batchRouter);
  app.use(errorHandler);
  return app;
}

describe("batch routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();

    (iot.getSolarData as jest.Mock).mockReturnValue({ efficiency_pct: 80, power_output_kw: 400, max_power_kw: 1000 });
    (iot.getSatelliteData as jest.Mock).mockReturnValue({ forest_density_pct: 50, ndvi_score: 0.5 });
    (scoring.computeScores as jest.Mock).mockReturnValue({ credit_quality: 80, green_impact: 65 });
    (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-batch");
    (registry.getTotalProjects as jest.Mock).mockResolvedValue(3);
  });

  it("POST /api/admin/batch/score-update — returns 202 with batch_id", async () => {
    const res = await request(app)
      .post("/api/admin/batch/score-update")
      .send({ project_ids: [1, 2], concurrency: 2 })
      .expect(202);

    expect(res.body).toMatchObject({
      batch_id: expect.stringContaining("batch_"),
      status: "queued",
      total: 2,
      concurrency: 2,
    });
  });

  it("POST /api/admin/batch/score-update — uses all projects when no ids given", async () => {
    const res = await request(app)
      .post("/api/admin/batch/score-update")
      .send({})
      .expect(202);
    expect(res.body.total).toBe(3);
  });

  it("POST /api/admin/batch/score-update — rejects non-integer project_ids", async () => {
    await request(app)
      .post("/api/admin/batch/score-update")
      .send({ project_ids: ["a", "b"] })
      .expect(400);
  });

  it("GET /api/admin/batch/:id/status — 404 for unknown batch", async () => {
    await request(app)
      .get("/api/admin/batch/unknown-id/status")
      .expect(404);
  });

  it("GET /api/admin/batch/:id/status — returns progress after creation", async () => {
    const create = await request(app)
      .post("/api/admin/batch/score-update")
      .send({ project_ids: [1] })
      .expect(202);

    const batchId = create.body.batch_id;
    // Give the async job a tick to start
    await new Promise((r) => setTimeout(r, 50));

    const status = await request(app)
      .get(`/api/admin/batch/${batchId}/status`)
      .expect(200);

    expect(status.body.batch_id).toBe(batchId);
    expect(status.body.progress).toHaveProperty("total", 1);
  });
});
