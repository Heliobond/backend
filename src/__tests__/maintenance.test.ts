import request from "supertest";
import express, { Express } from "express";
import {
  analyzeEfficiencyTrend,
  predictFailure,
  recommendMaintenance,
  generateSchedule,
  generateFullReport,
  recommendationToCsv,
  scheduleToCsv,
} from "../lib/maintenance";
import { setPanelConfig } from "../lib/panels";
import maintenanceRouter from "../routes/maintenance";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/maintenance", maintenanceRouter);
  app.use(errorHandler);
  return app;
}

describe("analyzeEfficiencyTrend", () => {
  it("returns trend analysis with monthly and weekly averages", () => {
    const result = analyzeEfficiencyTrend(1, 168);
    expect(result.project_id).toBe(1);
    expect(result.trend.direction).toMatch(/improving|declining|stable/);
    expect(result.trend.degradation_rate_pct_per_year).toBeGreaterThanOrEqual(0);
    expect(result.trend.r_squared).toBeGreaterThanOrEqual(0);
    expect(result.trend.r_squared).toBeLessThanOrEqual(1);
    expect(result.trend.sample_count).toBe(168);
    expect(result.monthly_averages.length).toBeGreaterThan(0);
    expect(result.weekly_averages.length).toBeGreaterThan(0);
  });

  it("returns consistent results for same project", () => {
    const a = analyzeEfficiencyTrend(1, 168);
    const b = analyzeEfficiencyTrend(1, 168);
    expect(a.trend.slope).toBe(b.trend.slope);
    expect(a.trend.degradation_rate_pct_per_year).toBe(b.trend.degradation_rate_pct_per_year);
  });

  it("different projects have different trends", () => {
    const a = analyzeEfficiencyTrend(1, 168);
    const b = analyzeEfficiencyTrend(2, 168);
    expect(a.trend.baseline_avg).not.toBe(b.trend.baseline_avg);
  });
});

describe("predictFailure", () => {
  it("returns failure prediction with valid fields", () => {
    const result = predictFailure(1, 720);
    expect(result.project_id).toBe(1);
    expect(result.current_efficiency).toBeGreaterThan(0);
    expect(result.critical_threshold).toBeGreaterThan(0);
    expect(result.severity).toMatch(/none|low|medium|high|critical/);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.trend_quality).toBeGreaterThanOrEqual(0);
    expect(result.panel_type).toBeTruthy();
  });

  it("uses panel config threshold if available", () => {
    setPanelConfig(999, {
      panel_type: "thin-film",
      efficiency_rating: 18,
      capacity_kw: 500,
      orientation: "S",
      tilt_angle: 30,
      shading_factor: 0.1,
    });
    const result = predictFailure(999, 720);
    expect(result.critical_threshold).toBe(60);
    expect(result.panel_type).toBe("thin-film");
  });

  it("returns critical severity when efficiency is very low", () => {
    const result = predictFailure(999, 720);
    const analysis = analyzeEfficiencyTrend(999, 720);
    const avg = analysis.trend.current_avg;
    if (avg < 60) {
      expect(result.severity).toBe("critical");
    }
  });
});

describe("recommendMaintenance", () => {
  it("returns recommendations with actions", () => {
    setPanelConfig(100, {
      panel_type: "monocrystalline",
      efficiency_rating: 20,
      capacity_kw: 500,
      orientation: "S",
      tilt_angle: 30,
      shading_factor: 0,
    });
    const result = recommendMaintenance(100, 720);
    expect(result.project_id).toBe(100);
    expect(result.panel_type).toBe("monocrystalline");
    expect(result.current_efficiency).toBeGreaterThan(0);
    expect(result.overall_health).toMatch(/good|fair|poor|critical/);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.summary).toBeTruthy();
  });

  it("includes cleaning action for high shading factor", () => {
    setPanelConfig(101, {
      panel_type: "bifacial",
      efficiency_rating: 22,
      capacity_kw: 500,
      orientation: "S",
      tilt_angle: 25,
      shading_factor: 0.5,
    });
    const result = recommendMaintenance(101, 720);
    const cleaningAction = result.actions.find((a) => a.type === "cleaning");
    expect(cleaningAction).toBeDefined();
    expect(cleaningAction!.priority).toBe("high");
  });

  it("returns actions sorted by priority", () => {
    const result = recommendMaintenance(1, 720);
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < result.actions.length; i++) {
      expect(order[result.actions[i - 1].priority]).toBeLessThanOrEqual(
        order[result.actions[i].priority],
      );
    }
  });

  it("all actions have non-negative cost", () => {
    const result = recommendMaintenance(1, 720);
    for (const action of result.actions) {
      expect(action.estimated_cost).toBeGreaterThan(0);
      expect(typeof action.urgency_hours).toBe("number");
    }
  });
});

describe("generateSchedule", () => {
  it("returns a dated schedule with entries", () => {
    const result = generateSchedule(1, 720);
    expect(result.project_id).toBe(1);
    expect(result.generated_at).toBeTruthy();
    expect(result.schedule.length).toBeGreaterThan(0);
  });

  it("each schedule entry has date, actions, and priority", () => {
    const result = generateSchedule(1, 720);
    for (const entry of result.schedule) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.actions.length).toBeGreaterThan(0);
      expect(entry.priority).toMatch(/low|medium|high|critical/);
    }
  });
});

describe("generateFullReport", () => {
  it("returns all report sections", () => {
    const result = generateFullReport(1, 720);
    expect(result.project_id).toBe(1);
    expect(result.generated_at).toBeTruthy();
    expect(result.trend_analysis).toBeDefined();
    expect(result.failure_prediction).toBeDefined();
    expect(result.recommendation).toBeDefined();
    expect(result.schedule).toBeDefined();
    expect(result.trend_analysis.trend.sample_count).toBe(720);
  });
});

describe("CSV export", () => {
  it("recommendationToCsv includes header and action rows", () => {
    const recommendation = recommendMaintenance(1, 168);
    const csv = recommendationToCsv(recommendation);
    expect(csv).toContain("project_id,panel_type,current_efficiency");
    expect(csv.trim().split("\n").length).toBe(recommendation.actions.length + 1);
  });

  it("scheduleToCsv includes header and rows", () => {
    const schedule = generateSchedule(1, 168);
    const csv = scheduleToCsv(schedule);
    expect(csv).toContain("project_id,date,priority,action_type");
    expect(csv.split("\n").length).toBeGreaterThan(1);
    expect(csv.trim()).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("maintenance API routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("GET /api/maintenance/1/trend — returns efficiency trend", async () => {
    const res = await request(app).get("/api/maintenance/1/trend").expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body.trend).toBeDefined();
    expect(res.body.trend.direction).toMatch(/improving|declining|stable/);
    expect(res.body.monthly_averages).toBeInstanceOf(Array);
    expect(res.body.weekly_averages).toBeInstanceOf(Array);
  });

  it("GET /api/maintenance/1/trend?history_hours=48 — respects history_hours", async () => {
    const res = await request(app).get("/api/maintenance/1/trend?history_hours=48").expect(200);
    expect(res.body.trend.sample_count).toBe(48);
  });

  it("GET /api/maintenance/1/failure-prediction — returns failure prediction", async () => {
    const res = await request(app).get("/api/maintenance/1/failure-prediction").expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body.current_efficiency).toBeGreaterThan(0);
    expect(res.body.critical_threshold).toBeGreaterThan(0);
    expect(res.body.severity).toMatch(/none|low|medium|high|critical/);
    expect(res.body.confidence).toBeGreaterThanOrEqual(0);
  });

  it("GET /api/maintenance/1/failure-prediction?format=csv — returns CSV", async () => {
    const res = await request(app)
      .get("/api/maintenance/1/failure-prediction?format=csv")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("current_efficiency");
  });

  it("GET /api/maintenance/1/recommendation — returns maintenance recommendation", async () => {
    const res = await request(app).get("/api/maintenance/1/recommendation").expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body.overall_health).toMatch(/good|fair|poor|critical/);
    expect(res.body.actions).toBeInstanceOf(Array);
    expect(res.body.actions.length).toBeGreaterThan(0);
    expect(res.body.summary).toBeTruthy();
  });

  it("GET /api/maintenance/1/recommendation?format=csv — returns CSV", async () => {
    const res = await request(app).get("/api/maintenance/1/recommendation?format=csv").expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("action_type,priority");
  });

  it("GET /api/maintenance/1/schedule — returns maintenance schedule", async () => {
    const res = await request(app).get("/api/maintenance/1/schedule").expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body.schedule).toBeInstanceOf(Array);
    expect(res.body.schedule.length).toBeGreaterThan(0);
    expect(res.body.schedule[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("GET /api/maintenance/1/schedule?format=csv — returns CSV", async () => {
    const res = await request(app).get("/api/maintenance/1/schedule?format=csv").expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("action_type,description");
  });

  it("GET /api/maintenance/1/full-report — returns all sections", async () => {
    const res = await request(app).get("/api/maintenance/1/full-report").expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body.trend_analysis).toBeDefined();
    expect(res.body.failure_prediction).toBeDefined();
    expect(res.body.recommendation).toBeDefined();
    expect(res.body.schedule).toBeDefined();
  });

  it("GET /api/maintenance/abc/trend — 400 for invalid id", async () => {
    const res = await request(app).get("/api/maintenance/abc/trend").expect(400);
    expect(res.body.error).toBe("bad_request");
  });
});
