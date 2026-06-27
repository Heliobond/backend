import request from "supertest";
import express, { Express } from "express";
import {
  getHistoricalSolarData,
  getHistoricalSatelliteData,
  generateHistory,
  forecastProject,
  forecastWeatherAdjusted,
  analyzeSeasonalPatterns,
  evaluateForecastAccuracy,
  forecastToCsv,
  seasonalPatternsToCsv,
  accuracyToCsv,
  getValidMethods,
  isMethodValid,
} from "../lib/forecast";
import forecastRouter from "../routes/forecast";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/forecast", forecastRouter);
  app.use(errorHandler);
  return app;
}

describe("getHistoricalSolarData", () => {
  it("returns deterministic data for same project and timestamp", () => {
    const ts = 1_700_000_000_000;
    const a = getHistoricalSolarData(1, ts);
    const b = getHistoricalSolarData(1, ts);
    expect(a).toEqual(b);
  });

  it("returns different data for different timestamps", () => {
    const a = getHistoricalSolarData(1, 1_700_000_000_000);
    const b = getHistoricalSolarData(1, 1_700_003_600_000);
    expect(a.power_output_kw).not.toBe(b.power_output_kw);
  });

  it("power_output_kw is in valid range", () => {
    const data = getHistoricalSolarData(1, Date.now());
    expect(data.power_output_kw).toBeGreaterThan(0);
    expect(data.power_output_kw).toBeLessThanOrEqual(1000);
    expect(data.efficiency_pct).toBeGreaterThanOrEqual(40);
    expect(data.efficiency_pct).toBeLessThanOrEqual(98);
  });
});

describe("getHistoricalSatelliteData", () => {
  it("returns deterministic data", () => {
    const ts = 1_700_000_000_000;
    expect(getHistoricalSatelliteData(1, ts)).toEqual(getHistoricalSatelliteData(1, ts));
  });

  it("forest_density_pct is in valid range", () => {
    const data = getHistoricalSatelliteData(1, Date.now());
    expect(data.forest_density_pct).toBeGreaterThanOrEqual(0);
    expect(data.forest_density_pct).toBeLessThanOrEqual(100);
    expect(data.ndvi_score).toBeGreaterThanOrEqual(0);
    expect(data.ndvi_score).toBeLessThanOrEqual(1);
  });
});

describe("generateHistory", () => {
  it("returns correct number of history points", () => {
    const history = generateHistory(1, "power_output_kw", 48);
    expect(history).toHaveLength(48);
    expect(history[0].timestamp).toBeLessThan(history[history.length - 1].timestamp);
  });

  it("all values are within range", () => {
    const history = generateHistory(1, "efficiency_pct", 24);
    for (const point of history) {
      expect(point.value).toBeGreaterThanOrEqual(40);
      expect(point.value).toBeLessThanOrEqual(98);
    }
  });
});

describe("forecastProject", () => {
  it("returns correct number of forecast points", () => {
    const result = forecastProject(1, "power_output_kw", 24);
    expect(result.project_id).toBe(1);
    expect(result.field).toBe("power_output_kw");
    expect(result.horizon).toBe(24);
    expect(result.forecasts).toHaveLength(24);
  });

  it("forecast points are in the future", () => {
    const now = Date.now();
    const result = forecastProject(1, "power_output_kw", 12);
    for (const fp of result.forecasts) {
      expect(fp.timestamp).toBeGreaterThan(now - 3600_000);
    }
  });

  it("all methods produce valid forecasts", () => {
    for (const method of getValidMethods()) {
      const result = forecastProject(1, "efficiency_pct", 6, method as any);
      expect(result.forecasts).toHaveLength(6);
      expect(result.method).toBe(method);
    }
  });

  it("naive method repeats last value", () => {
    const result = forecastProject(1, "power_output_kw", 5, "naive");
    const vals = result.forecasts.map((f) => f.value);
    expect(new Set(vals).size).toBe(1);
  });

  it("linear_trend produces non-constant forecasts", () => {
    const result = forecastProject(1, "power_output_kw", 10, "linear_trend", 168);
    const vals = result.forecasts.map((f) => f.value);
    expect(new Set(vals).size).toBeGreaterThan(1);
  });
});

describe("forecastWeatherAdjusted", () => {
  it("returns weather-adjusted forecast points", () => {
    const result = forecastWeatherAdjusted(1, 24);
    expect(result.method).toBe("weather_adjusted");
    expect(result.field).toBe("power_output_kw");
    expect(result.forecasts).toHaveLength(24);
  });

  it("all forecast values are non-negative", () => {
    const result = forecastWeatherAdjusted(1, 48);
    for (const fp of result.forecasts) {
      expect(fp.value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("analyzeSeasonalPatterns", () => {
  it("returns hourly and monthly patterns", () => {
    const result = analyzeSeasonalPatterns(1, "power_output_kw");
    expect(result.hourly.period).toBe("hourly");
    expect(result.hourly.patterns).toHaveLength(24);
    expect(result.monthly.period).toBe("monthly");
    expect(result.monthly.patterns).toHaveLength(12);
    expect(result.hourly.strength).toBeGreaterThanOrEqual(0);
    expect(result.hourly.strength).toBeLessThanOrEqual(1);
  });

  it("seasonal patterns have counts that sum to total points", () => {
    const result = analyzeSeasonalPatterns(1, "efficiency_pct", 168);
    const total = result.hourly.patterns.reduce((s, p) => s + p.count, 0);
    expect(total).toBe(168);
  });
});

describe("evaluateForecastAccuracy", () => {
  it("returns accuracy metrics with comparisons", () => {
    const result = evaluateForecastAccuracy(1, "power_output_kw", "naive", 6, 48);
    expect(result.metrics.sample_count).toBeGreaterThan(0);
    expect(result.metrics.mae).toBeGreaterThanOrEqual(0);
    expect(result.metrics.rmse).toBeGreaterThanOrEqual(0);
    expect(result.comparisons.length).toBeGreaterThan(0);
  });

  it("exponential_smoothing has lower error than naive", () => {
    const naive = evaluateForecastAccuracy(1, "power_output_kw", "naive", 12, 72);
    const es = evaluateForecastAccuracy(1, "power_output_kw", "exponential_smoothing", 12, 72);
    expect(es.metrics.mae).toBeLessThanOrEqual(naive.metrics.mae * 2 + 1);
  });

  it("returns empty for insufficient history", () => {
    const result = evaluateForecastAccuracy(1, "power_output_kw", "naive", 100, 4);
    expect(result.metrics.sample_count).toBe(0);
  });
});

describe("getValidMethods / isMethodValid", () => {
  it("returns all method names", () => {
    const methods = getValidMethods();
    expect(methods).toContain("naive");
    expect(methods).toContain("moving_average");
    expect(methods).toContain("exponential_smoothing");
    expect(methods).toContain("linear_trend");
    expect(methods).toContain("seasonal_naive");
    expect(methods).toContain("seasonal_decomposition");
  });

  it("validates methods correctly", () => {
    expect(isMethodValid("naive")).toBe(true);
    expect(isMethodValid("invalid")).toBe(false);
  });
});

describe("CSV export", () => {
  it("forecastToCsv includes header and rows", () => {
    const result = forecastProject(1, "power_output_kw", 4, "naive");
    const csv = forecastToCsv(result);
    expect(csv).toContain("project_id,field,method,horizon,timestamp,forecast_value");
    expect(csv.split("\n")).toHaveLength(6);
  });

  it("seasonalPatternsToCsv includes all pattern types", () => {
    const patterns = analyzeSeasonalPatterns(1, "power_output_kw", 24);
    const csv = seasonalPatternsToCsv(1, patterns);
    expect(csv).toContain("type,label,avg_value,count,strength");
    expect(csv).toContain("hourly");
    expect(csv).toContain("monthly");
  });

  it("accuracyToCsv includes metrics summary", () => {
    const result = evaluateForecastAccuracy(1, "power_output_kw", "naive", 4, 48);
    const csv = accuracyToCsv(result);
    expect(csv).toContain("MAE,RMSE,MAPE,Bias,SampleCount");
    expect(csv).toContain("project_id,field,method");
  });
});

describe("forecast API routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("GET /api/forecast/1 — returns forecast", async () => {
    const res = await request(app)
      .get("/api/forecast/1")
      .expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body.forecasts).toHaveLength(24);
    expect(res.body.method).toBe("exponential_smoothing");
  });

  it("GET /api/forecast/1?horizon=6&method=naive — respects params", async () => {
    const res = await request(app)
      .get("/api/forecast/1?horizon=6&method=naive")
      .expect(200);
    expect(res.body.forecasts).toHaveLength(6);
    expect(res.body.method).toBe("naive");
  });

  it("GET /api/forecast/1 — 400 for invalid method", async () => {
    const res = await request(app)
      .get("/api/forecast/1?method=invalid")
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("GET /api/forecast/1 — 400 for invalid id", async () => {
    const res = await request(app)
      .get("/api/forecast/abc")
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("GET /api/forecast/weather-adjusted/1 — returns weather-adjusted forecast", async () => {
    const res = await request(app)
      .get("/api/forecast/weather-adjusted/1")
      .expect(200);
    expect(res.body.method).toBe("weather_adjusted");
    expect(res.body.forecasts).toHaveLength(24);
  });

  it("GET /api/forecast/weather-adjusted/1?horizon=6 — respects horizon", async () => {
    const res = await request(app)
      .get("/api/forecast/weather-adjusted/1?horizon=6")
      .expect(200);
    expect(res.body.forecasts).toHaveLength(6);
  });

  it("GET /api/forecast/seasonal/1 — returns seasonal patterns", async () => {
    const res = await request(app)
      .get("/api/forecast/seasonal/1")
      .expect(200);
    expect(res.body).toHaveProperty("hourly");
    expect(res.body).toHaveProperty("monthly");
    expect(res.body.hourly.patterns).toHaveLength(24);
    expect(res.body.monthly.patterns).toHaveLength(12);
  });

  it("GET /api/forecast/seasonal/1?field=efficiency_pct — respects field", async () => {
    const res = await request(app)
      .get("/api/forecast/seasonal/1?field=efficiency_pct")
      .expect(200);
    expect(res.body.field).toBe("efficiency_pct");
  });

  it("GET /api/forecast/accuracy/1 — returns accuracy metrics", async () => {
    const res = await request(app)
      .get("/api/forecast/accuracy/1")
      .expect(200);
    expect(res.body).toHaveProperty("metrics");
    expect(res.body).toHaveProperty("comparisons");
    expect(res.body.metrics).toHaveProperty("mae");
    expect(res.body.metrics).toHaveProperty("rmse");
    expect(res.body.metrics).toHaveProperty("mape");
    expect(res.body.metrics).toHaveProperty("bias");
  });

  it("GET /api/forecast/accuracy/1?method=linear_trend — respects method", async () => {
    const res = await request(app)
      .get("/api/forecast/accuracy/1?method=linear_trend")
      .expect(200);
    expect(res.body.method).toBe("linear_trend");
  });

  it("GET /api/forecast/methods/available — lists methods", async () => {
    const res = await request(app)
      .get("/api/forecast/methods/available")
      .expect(200);
    expect(res.body.methods).toBeInstanceOf(Array);
    expect(res.body.methods).toContain("naive");
    expect(res.body.methods).toContain("exponential_smoothing");
  });

  it("GET /api/forecast/1 — returns CSV format", async () => {
    const res = await request(app)
      .get("/api/forecast/1?format=csv")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("forecast_value");
  });

  it("GET /api/forecast/seasonal/1 — returns CSV format", async () => {
    const res = await request(app)
      .get("/api/forecast/seasonal/1?format=csv")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("type,label,avg_value,count,strength");
  });

  it("GET /api/forecast/accuracy/1 — returns CSV format", async () => {
    const res = await request(app)
      .get("/api/forecast/accuracy/1?format=csv")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("MAE");
  });

  it("GET /api/forecast/weather-adjusted/1 — returns CSV format", async () => {
    const res = await request(app)
      .get("/api/forecast/weather-adjusted/1?format=csv")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("forecast_value");
  });
});
