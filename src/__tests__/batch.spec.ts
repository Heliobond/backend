import request from "supertest";
import type { Response } from "supertest";
import express, { Express } from "express";
import batchRouter from "../routes/batch";
import { errorHandler } from "../middleware/errors";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import { createJob, runJob } from "../lib/batch";

jest.mock("../config", () => ({
  config: { PROJECT_REGISTRY_CONTRACT_ID: "dummy-registry-id" },
}));
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

    (iot.getSolarData as jest.Mock).mockReturnValue({
      efficiency_pct: 80,
      power_output_kw: 400,
      max_power_kw: 1000,
    });
    (iot.getSatelliteData as jest.Mock).mockReturnValue({
      forest_density_pct: 50,
      ndvi_score: 0.5,
    });
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
    const res = await request(app).post("/api/admin/batch/score-update").send({}).expect(202);
    expect(res.body.total).toBe(3);
  });

  it("POST /api/admin/batch/score-update — rejects non-integer project_ids", async () => {
    await request(app)
      .post("/api/admin/batch/score-update")
      .send({ project_ids: ["a", "b"] })
      .expect(400);
  });

  it("GET /api/admin/batch/:id/status — 404 for unknown batch", async () => {
    await request(app).get("/api/admin/batch/unknown-id/status").expect(404);
  });

  it("GET /api/admin/batch/:id/status — returns progress after creation", async () => {
    const create = await request(app)
      .post("/api/admin/batch/score-update")
      .send({ project_ids: [1] })
      .expect(202);

    const batchId = create.body.batch_id;

    let statusResponse: Response | undefined;
    for (let attempt = 0; attempt < 25; attempt++) {
      statusResponse = await request(app).get(`/api/admin/batch/${batchId}/status`);
      if (statusResponse.status === 200 && statusResponse.body.progress?.total === 1) {
        break;
      }
      await Promise.resolve();
    }

    expect(statusResponse).toBeDefined();
    expect(statusResponse!.status).toBe(200);
    expect(statusResponse!.body.batch_id).toBe(batchId);
    expect(statusResponse!.body.progress).toHaveProperty("total", 1);
  });
});

describe("batch lib — runJob with rejecting processor", () => {
  it("does not hang and records the rejection as an error result", async () => {
    const job = createJob([1, 2, 3], 2);
    const processor = jest.fn(async (id: number) => {
      if (id === 2) throw new Error("boom");
      return { project_id: id };
    });

    await runJob(job, processor);

    expect(job.status).toBe("completed");
    expect(job.progress.done).toBe(3);
    expect(job.results).toHaveLength(2);
    expect(job.errors).toHaveLength(1);
    expect(job.errors[0]).toMatchObject({ project_id: 2, error: "Error: boom" });
    expect(job.errors[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("marks the job failed when every item rejects", async () => {
    const job = createJob([1, 2], 2);
    const processor = jest.fn(async () => {
      throw new Error("always fails");
    });

    await runJob(job, processor);

    expect(job.status).toBe("failed");
    expect(job.progress.done).toBe(2);
    expect(job.results).toHaveLength(0);
    expect(job.errors).toHaveLength(2);
  });

  it("decodes contract errors thrown by processor into job.errors", async () => {
    const job = createJob([1], 1);
    const processor = jest.fn(async (id: number) => {
      throw new Error("HostError: Error(Contract, #7)");
    });

    await runJob(job, processor);

    expect(job.errors).toHaveLength(1);
    expect(job.errors[0]).toMatchObject({
      project_id: 1,
      error: expect.stringContaining("Error(Contract, #7)"),
      contract_error_name: "ProjectNotFound",
      contract_error_code: 7,
    });
  });

  it("decodes contract errors returned in result.error into job.errors", async () => {
    const job = createJob([1], 1);
    const processor = jest.fn(async (id: number) => {
      return {
        project_id: id,
        error: "HostError: Error(Contract, #8)",
      };
    });

    await runJob(job, processor);

    expect(job.errors).toHaveLength(1);
    expect(job.errors[0]).toMatchObject({
      project_id: 1,
      error: "HostError: Error(Contract, #8)",
      contract_error_name: "ScoresOutOfRange",
      contract_error_code: 8,
    });
  });
});
