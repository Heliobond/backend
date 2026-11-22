import request from "supertest";
import express, { Express } from "express";
import investorRouter from "../routes/investor";
import { errorHandler } from "../middleware/errors";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import { clearAuditLog, recordAudit } from "../lib/audit";

jest.mock("../lib/registry", () => ({
  getTotalProjects: jest.fn(),
}));
jest.mock("../routes/iot");
jest.mock("../lib/scoring");

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/investor", investorRouter);
  app.use(errorHandler);
  return app;
}

describe("Investor Reporting Endpoints", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    clearAuditLog();

    (registry.getTotalProjects as jest.Mock).mockResolvedValue(2);
    (iot.getSolarData as jest.Mock).mockImplementation((id: number) => ({
      power_output_kw: 500 + id * 50,
      efficiency_pct: 80 + id * 2,
      max_power_kw: 1000,
      timestamp: Date.now(),
    }));
    (iot.getSatelliteData as jest.Mock).mockImplementation((id: number) => ({
      forest_density_pct: 70 + id * 2,
      ndvi_score: 0.7 + id * 0.05,
      timestamp: Date.now(),
    }));
    (scoring.computeScores as jest.Mock).mockImplementation(() => ({
      credit_quality: 85,
      green_impact: 75,
    }));
  });

  describe("GET /dashboard", () => {
    it("should return aggregated portfolio metrics", async () => {
      recordAudit({
        project_id: 1,
        credit_quality: 85,
        green_impact: 75,
        tx_hash: "tx123",
        triggered_by: "test",
      });

      const res = await request(app).get("/api/investor/dashboard");
      expect(res.status).toBe(200);
      expect(res.body.portfolio_summary).toEqual({
        total_projects: 2,
        total_power_output_kw: 1150,
        avg_credit_quality: 85,
        avg_green_impact: 75,
        total_portfolio_value: 950000, // project 1 (400000) + project 2 (550000)
        total_carbon_offsets_tonnes: 4312.5, // 550 * 75 * 0.05 + 600 * 75 * 0.05
      });
      expect(res.body.recent_activities.length).toBe(1);
      expect(res.body.recent_activities[0].tx_hash).toBe("tx123");
    });
  });

  describe("GET /performance-report", () => {
    it("should return project-by-project performance indicators", async () => {
      const res = await request(app).get("/api/investor/performance-report");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("generated_at");
      expect(res.body.projects.length).toBe(2);
      expect(res.body.projects[0]).toEqual({
        project_id: 1,
        efficiency_pct: 82,
        power_output_kw: 550,
        ndvi_score: 0.75,
        actual_vs_expected_ratio: 0.55, // 550 / 1000
        performance_status: "Critical",
      });
    });
  });

  describe("GET /financial-summary", () => {
    it("should return financial details and aggregated KPIs", async () => {
      const res = await request(app).get("/api/investor/financial-summary");
      expect(res.status).toBe(200);
      expect(res.body.portfolio_financials).toHaveProperty("total_installation_cost");
      expect(res.body.portfolio_financials).toHaveProperty("total_npv");
      expect(res.body.projects.length).toBe(2);
    });
  });

  describe("GET /compliance-report", () => {
    it("should return ESG scores and audit logs", async () => {
      const res = await request(app).get("/api/investor/compliance-report");
      expect(res.status).toBe(200);
      expect(res.body.portfolio_compliance.portfolio_esg_score).toBe(75);
      expect(res.body.projects.length).toBe(2);
    });
  });

  describe("POST /custom-report", () => {
    it("should generate a custom filtered report", async () => {
      const res = await request(app)
        .post("/api/investor/custom-report")
        .send({
          project_ids: [1],
          sections: ["performance", "scores"],
        });

      expect(res.status).toBe(200);
      expect(res.body.project_count).toBe(1);
      expect(res.body.projects[0]).toHaveProperty("project_id", 1);
      expect(res.body.projects[0]).toHaveProperty("scores");
      expect(res.body.projects[0]).toHaveProperty("performance");
      expect(res.body.projects[0]).not.toHaveProperty("financials");
    });

    it("should reject invalid project_ids", async () => {
      const res = await request(app)
        .post("/api/investor/custom-report")
        .send({ project_ids: "not-an-array" });
      expect(res.status).toBe(400);
    });

    it("should reject invalid sections", async () => {
      const res = await request(app)
        .post("/api/investor/custom-report")
        .send({ sections: ["invalid-section"] });
      expect(res.status).toBe(400);
    });
  });
});
