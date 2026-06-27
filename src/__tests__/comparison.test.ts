import request from "supertest";
import express, { Express } from "express";
import comparisonRouter from "../routes/comparison";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/comparison", comparisonRouter);
  app.use(errorHandler);
  return app;
}

describe("comparison routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("GET /api/comparison — compares projects side by side", async () => {
    const res = await request(app)
      .get("/api/comparison?ids=1,2,3")
      .expect(200);
    expect(res.body.projects).toHaveLength(3);
    expect(res.body.metrics).toBeDefined();
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.highest_combined).toBeDefined();
    expect(res.body.summary.lowest_combined).toBeDefined();
  });

  it("GET /api/comparison — 400 for missing ids", async () => {
    const res = await request(app)
      .get("/api/comparison")
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("GET /api/comparison — 400 for invalid id", async () => {
    const res = await request(app)
      .get("/api/comparison?ids=abc")
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("GET /api/comparison — 400 for too many ids", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => i + 1).join(",");
    const res = await request(app)
      .get(`/api/comparison?ids=${ids}`)
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("GET /api/comparison/metrics — returns available metrics", async () => {
    const res = await request(app)
      .get("/api/comparison/metrics")
      .expect(200);
    expect(res.body.metrics).toBeInstanceOf(Array);
    expect(res.body.metrics.length).toBeGreaterThan(0);
    expect(res.body.metrics[0]).toHaveProperty("key");
    expect(res.body.metrics[0]).toHaveProperty("label");
  });

  it("GET /api/comparison/ranking — ranks projects by criteria", async () => {
    const res = await request(app)
      .get("/api/comparison/ranking?ids=1,2,3&criteria=green_impact")
      .expect(200);
    expect(res.body.criteria).toBe("green_impact");
    expect(res.body.rankings).toHaveLength(3);
    expect(res.body.rankings[0]).toHaveProperty("rank");
    expect(res.body.rankings[0].rank).toBe(1);
  });

  it("GET /api/comparison/ranking — 400 for invalid criteria", async () => {
    const res = await request(app)
      .get("/api/comparison/ranking?ids=1,2,3&criteria=invalid")
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("GET /api/comparison/export — returns CSV", async () => {
    const res = await request(app)
      .get("/api/comparison/export?ids=1,2")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("project_id");
  });

  it("GET /api/comparison/ranking/export — returns ranking CSV", async () => {
    const res = await request(app)
      .get("/api/comparison/ranking/export?ids=1,2,3&criteria=credit_quality")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("rank,project_id");
  });
});
