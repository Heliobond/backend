import request from "supertest";
import express, { Express } from "express";
import anomalyRouter from "../routes/anomaly";
import { errorHandler } from "../middleware/errors";
import {
  clearHistory,
  configureAnomalyDetection,
  detectAnomalies,
  getAnomalyConfig,
} from "../lib/anomaly";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/anomaly", anomalyRouter);
  app.use(errorHandler);
  return app;
}

const DEFAULT_CONFIG = {
  sensitivityZScore: 2.5,
  trendWindowSize: 20,
  trendDeviationPct: 20,
  minBaseline: 5,
};

const baseReading = {
  efficiency_pct: 50,
  power_output_kw: 50,
  forest_density_pct: 50,
  ndvi_score: 0.5,
};

describe("detectAnomalies", () => {
  beforeEach(() => {
    clearHistory();
    configureAnomalyDetection(DEFAULT_CONFIG);
  });

  it("returns the result shape with no anomalies before baseline is met", () => {
    const result = detectAnomalies(1, baseReading);
    expect(result.projectId).toBe(1);
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.anomalies).toEqual([]);
    for (const metric of Object.keys(result.metrics) as Array<keyof typeof result.metrics>) {
      expect(result.metrics[metric]).toEqual({
        value: baseReading[metric],
        mean: baseReading[metric],
        stdDev: 0,
        zScore: 0,
      });
    }
  });

  it("flags an outlier once a varied baseline is established", () => {
    // minBaseline is 5: seed 5 varied readings, then send an extreme value.
    for (let i = 0; i < 5; i++) {
      detectAnomalies(1, { ...baseReading, efficiency_pct: i % 2 === 0 ? 50 : 51 });
    }
    const result = detectAnomalies(1, { ...baseReading, efficiency_pct: 0 });
    const outlier = result.anomalies.find(
      (a) => a.type === "outlier" && a.metric === "efficiency_pct",
    );
    expect(outlier).toBeDefined();
    expect(outlier!.severity).toBe("high");
    expect(result.metrics.efficiency_pct.zScore).toBeLessThan(-2.5);
  });

  it("flags a trend when a value deviates from a stable baseline", () => {
    for (let i = 0; i < 5; i++) {
      detectAnomalies(1, baseReading);
    }
    const result = detectAnomalies(1, { ...baseReading, power_output_kw: 100 });
    const trend = result.anomalies.find(
      (a) => a.type === "trend" && a.metric === "power_output_kw",
    );
    expect(trend).toBeDefined();
    expect(trend!.severity).toBe("high");
    expect(trend!.deviation).toBeGreaterThan(0);
  });

  it("does not flag values within the sensitivity threshold", () => {
    for (let i = 0; i < 5; i++) {
      detectAnomalies(1, { ...baseReading, efficiency_pct: i % 2 === 0 ? 50 : 51 });
    }
    const result = detectAnomalies(1, { ...baseReading, efficiency_pct: 50 });
    expect(result.anomalies).toEqual([]);
  });

  it("survives a zero-value baseline without triggering alerts or NaN", () => {
    for (let i = 0; i < 5; i++) {
      detectAnomalies(1, { ...baseReading, ndvi_score: 0 });
    }
    const result = detectAnomalies(1, { ...baseReading, ndvi_score: 1 });
    expect(result.anomalies).toEqual([]);
    expect(result.metrics.ndvi_score.stdDev).toBe(0);
    expect(result.metrics.ndvi_score.zScore).toBe(0);
  });

  it("respects a per-call config override without mutating global config", () => {
    for (let i = 0; i < 5; i++) {
      detectAnomalies(1, { ...baseReading, efficiency_pct: i % 2 === 0 ? 50 : 51 });
    }
    const suppressed = detectAnomalies(
      1,
      { ...baseReading, efficiency_pct: 0 },
      { sensitivityZScore: 1000, trendDeviationPct: 1000 },
    );
    expect(suppressed.anomalies).toEqual([]);
    expect(getAnomalyConfig().sensitivityZScore).toBe(DEFAULT_CONFIG.sensitivityZScore);
  });

  it("caps per-project history at the configured window size", () => {
    configureAnomalyDetection({ trendWindowSize: 3, minBaseline: 3 });
    for (let i = 0; i < 7; i++) {
      detectAnomalies(1, { ...baseReading, efficiency_pct: 90 });
    }
    for (let i = 0; i < 3; i++) {
      detectAnomalies(1, { ...baseReading, efficiency_pct: 50 });
    }
    const result = detectAnomalies(1, { ...baseReading, efficiency_pct: 50 });
    // Baseline mean reflects only the last 3 readings, not the older 90s.
    expect(result.metrics.efficiency_pct.mean).toBe(50);
  });
});

describe("configureAnomalyDetection / getAnomalyConfig", () => {
  beforeEach(() => {
    configureAnomalyDetection(DEFAULT_CONFIG);
  });

  it("returns defaults initially", () => {
    expect(getAnomalyConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("merges partial updates and keeps the rest of the defaults", () => {
    configureAnomalyDetection({ sensitivityZScore: 3.5 });
    expect(getAnomalyConfig()).toEqual({ ...DEFAULT_CONFIG, sensitivityZScore: 3.5 });
  });

  it("returns a copy so callers cannot mutate the stored config", () => {
    const config = getAnomalyConfig();
    config.sensitivityZScore = 99;
    expect(getAnomalyConfig().sensitivityZScore).toBe(DEFAULT_CONFIG.sensitivityZScore);
  });
});

describe("clearHistory", () => {
  beforeEach(() => {
    clearHistory();
    configureAnomalyDetection(DEFAULT_CONFIG);
  });

  it("clears a single project's history only", () => {
    for (let i = 0; i < 5; i++) detectAnomalies(1, baseReading);
    for (let i = 0; i < 5; i++) detectAnomalies(2, baseReading);

    clearHistory(1);

    // Project 1 must rebuild its baseline; project 2 still has one.
    const rebuilt = detectAnomalies(1, { ...baseReading, power_output_kw: 100 });
    const intact = detectAnomalies(2, { ...baseReading, power_output_kw: 100 });
    expect(rebuilt.anomalies).toEqual([]);
    expect(intact.anomalies.length).toBeGreaterThan(0);
  });

  it("clears all projects when called without an id", () => {
    for (let i = 0; i < 5; i++) detectAnomalies(1, baseReading);
    clearHistory();
    const result = detectAnomalies(1, { ...baseReading, power_output_kw: 100 });
    expect(result.anomalies).toEqual([]);
  });
});

describe("anomaly API routes", () => {
  let app: Express;

  beforeEach(() => {
    clearHistory();
    configureAnomalyDetection(DEFAULT_CONFIG);
    app = buildApp();
  });

  it("GET /v1/anomaly — returns the current detection config", async () => {
    const res = await request(app).get("/v1/anomaly").expect(200);
    expect(res.body).toEqual(DEFAULT_CONFIG);
  });

  it("GET /v1/anomaly/:id — runs detection and returns metrics", async () => {
    const res = await request(app).get("/v1/anomaly/1").expect(200);
    expect(res.body.projectId).toBe(1);
    expect(res.body.anomalies).toEqual([]);
    expect(Object.keys(res.body.metrics).sort()).toEqual([
      "efficiency_pct",
      "forest_density_pct",
      "ndvi_score",
      "power_output_kw",
    ]);
  });

  it("GET /v1/anomaly/:id — accepts sensitivity and window query params", async () => {
    const res = await request(app).get("/v1/anomaly/2?sensitivity=1.5&window=10").expect(200);
    expect(res.body.projectId).toBe(2);
    expect(res.body.metrics).toBeDefined();
  });

  it("GET /v1/anomaly/:id — 400 for invalid id", async () => {
    const res = await request(app).get("/v1/anomaly/abc").expect(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("GET /v1/anomaly/:id — 400 for id above the maximum", async () => {
    const res = await request(app).get("/v1/anomaly/100001").expect(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("PUT /v1/anomaly/config — updates config and echoes it back", async () => {
    const res = await request(app)
      .put("/v1/anomaly/config")
      .send({ sensitivityZScore: 3.5, trendWindowSize: 30 })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.config).toEqual({
      ...DEFAULT_CONFIG,
      sensitivityZScore: 3.5,
      trendWindowSize: 30,
    });
    expect(getAnomalyConfig().sensitivityZScore).toBe(3.5);
  });

  it("PUT /v1/anomaly/config — empty body keeps defaults intact", async () => {
    const res = await request(app).put("/v1/anomaly/config").send({}).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.config).toEqual(DEFAULT_CONFIG);
  });

  it("DELETE /v1/anomaly/history — clears all projects", async () => {
    await request(app).get("/v1/anomaly/1").expect(200); // seed history
    const res = await request(app).delete("/v1/anomaly/history").expect(200);
    expect(res.body).toEqual({ ok: true, cleared: "all" });
  });

  it("DELETE /v1/anomaly/history/:id — clears a single project", async () => {
    await request(app).get("/v1/anomaly/1").expect(200);
    const res = await request(app).delete("/v1/anomaly/history/1").expect(200);
    expect(res.body).toEqual({ ok: true, cleared: 1 });
  });

  it("DELETE /v1/anomaly/history/:id — 400 for invalid id", async () => {
    const res = await request(app).delete("/v1/anomaly/history/abc").expect(400);
    expect(res.body.error.code).toBe("bad_request");
  });
});
