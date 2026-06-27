import request from "supertest";
import express, { Express } from "express";
import benchmarkingRouter from "../routes/benchmarking";
import { errorHandler } from "../middleware/errors";
import { initBenchmarkSamples } from "../lib/benchmarking";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/benchmarking", benchmarkingRouter);
  app.use(errorHandler);
  return app;
}

describe("benchmarking routes", () => {
  let app: Express;

  beforeAll(() => {
    initBenchmarkSamples(10);
  });

  beforeEach(() => {
    app = buildApp();
  });

  it("GET /api/benchmarking/benchmarks — lists all benchmarks", async () => {
    const res = await request(app)
      .get("/api/benchmarking/benchmarks")
      .expect(200);
    expect(res.body.benchmarks).toBeInstanceOf(Array);
    expect(res.body.benchmarks.length).toBeGreaterThanOrEqual(5);
    expect(res.body.benchmarks[0]).toHaveProperty("id");
    expect(res.body.benchmarks[0]).toHaveProperty("thresholds");
  });

  it("GET /api/benchmarking/benchmarks/:id — returns a benchmark", async () => {
    const res = await request(app)
      .get("/api/benchmarking/benchmarks/credit_quality")
      .expect(200);
    expect(res.body.id).toBe("credit_quality");
    expect(res.body).toHaveProperty("thresholds");
  });

  it("GET /api/benchmarking/benchmarks/:id — 404 for unknown benchmark", async () => {
    const res = await request(app)
      .get("/api/benchmarking/benchmarks/nonexistent")
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("POST /api/benchmarking/benchmarks — creates a custom benchmark", async () => {
    const res = await request(app)
      .post("/api/benchmarking/benchmarks")
      .send({
        name: "Custom Test",
        metric: "credit_quality",
        thresholds: { poor: 10, fair: 30, good: 50, excellent: 80 },
        source: "Test Source",
      })
      .expect(201);
    expect(res.body.id).toBe("custom_test");
    expect(res.body.name).toBe("Custom Test");
  });

  it("POST /api/benchmarking/benchmarks — 400 for missing fields", async () => {
    const res = await request(app)
      .post("/api/benchmarking/benchmarks")
      .send({ name: "Incomplete" })
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("GET /api/benchmarking/:id — evaluates all benchmarks for a project", async () => {
    const res = await request(app)
      .get("/api/benchmarking/1")
      .expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body.benchmarks).toBeInstanceOf(Array);
    expect(res.body.benchmarks.length).toBeGreaterThanOrEqual(5);
    expect(res.body.benchmarks[0]).toHaveProperty("rating");
    expect(res.body.benchmarks[0]).toHaveProperty("percentile");
  });

  it("GET /api/benchmarking/:id/percentiles — returns percentile ranking", async () => {
    const res = await request(app)
      .get("/api/benchmarking/1/percentiles?metric=credit_quality")
      .expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body).toHaveProperty("percentile");
    expect(res.body).toHaveProperty("value");
  });

  it("GET /api/benchmarking/:id/alerts — returns benchmark alerts", async () => {
    const res = await request(app)
      .get("/api/benchmarking/1/alerts")
      .expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body.alerts).toBeInstanceOf(Array);
    expect(res.body).toHaveProperty("count");
  });

  it("GET /api/benchmarking/:id/trend — returns trend vs benchmark", async () => {
    const res = await request(app)
      .get("/api/benchmarking/1/trend?metric=credit_quality&benchmark=credit_quality")
      .expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body).toHaveProperty("current_value");
    expect(res.body).toHaveProperty("benchmark_value");
    expect(res.body).toHaveProperty("delta");
    expect(res.body).toHaveProperty("trend_direction");
  });

  it("GET /api/benchmarking/:id — 400 for invalid id", async () => {
    await request(app)
      .get("/api/benchmarking/abc")
      .expect(400);
  });
});
