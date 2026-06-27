import request from "supertest";
import express, { Express } from "express";
import historyRouter from "../routes/history";
import { errorHandler } from "../middleware/errors";
import { recordScoreHistory } from "../lib/history";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:id/history", historyRouter);
  app.use(errorHandler);
  return app;
}

describe("history routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    // Seed two entries 10 seconds apart
    recordScoreHistory(1, 70, 60, 1_000_000);
    recordScoreHistory(1, 80, 70, 1_010_000);
  });

  it("GET /api/projects/:id/history — returns all entries", async () => {
    const res = await request(app)
      .get("/api/projects/1/history")
      .expect(200);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
    expect(res.body.entries[0]).toHaveProperty("credit_quality");
  });

  it("GET /api/projects/:id/history — filters by time range", async () => {
    const res = await request(app)
      .get("/api/projects/1/history?from=1000000&to=1005000")
      .expect(200);
    expect(res.body.entries.every((e: { timestamp: number }) => e.timestamp <= 1_005_000)).toBe(true);
  });

  it("GET /api/projects/:id/history?format=csv — returns CSV", async () => {
    const res = await request(app)
      .get("/api/projects/1/history?format=csv")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("project_id,credit_quality,green_impact,timestamp");
  });

  it("GET /api/projects/:id/history/trend — returns trend analysis", async () => {
    const res = await request(app)
      .get("/api/projects/1/history/trend")
      .expect(200);
    expect(res.body).toHaveProperty("trend");
    expect(["improving", "declining", "stable"]).toContain(res.body.trend);
    expect(res.body).toHaveProperty("credit_quality_delta");
    expect(res.body).toHaveProperty("green_impact_delta");
  });

  it("GET /api/projects/:id/history — 400 for invalid id", async () => {
    await request(app).get("/api/projects/abc/history").expect(400);
  });
});
