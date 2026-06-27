import request from "supertest";
import express, { Express } from "express";
import {
  createDefaultFinancialInput,
  calculateCostBenefit,
  calculatePaybackPeriod,
  calculateNPV,
  performSensitivityAnalysis,
  compareROI,
} from "../lib/financial";
import financialRouter from "../routes/financial";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/financial", financialRouter);
  app.use(errorHandler);
  return app;
}

const BASE_INPUT = createDefaultFinancialInput(500, 80);

describe("createDefaultFinancialInput", () => {
  it("creates sensible defaults for a 500 kW system", () => {
    const input = createDefaultFinancialInput(500, 80);
    expect(input.system_capacity_kw).toBe(500);
    expect(input.installation_cost).toBe(500_000);
    expect(input.annual_maintenance_cost).toBe(7500);
    expect(input.annual_energy_output_kwh).toBe(500 * 8760 * 0.20);
    expect(input.electricity_price_per_kwh).toBe(0.10);
    expect(input.degradation_rate).toBe(0.005);
    expect(input.discount_rate).toBe(0.07);
    expect(input.project_lifetime_years).toBe(25);
    expect(input.tax_incentives).toBe(150_000);
    expect(input.salvage_value).toBe(50_000);
  });

  it("merges partial overrides", () => {
    const input = createDefaultFinancialInput(500, 80, {
      installation_cost: 600_000,
      discount_rate: 0.08,
    });
    expect(input.installation_cost).toBe(600_000);
    expect(input.discount_rate).toBe(0.08);
    expect(input.system_capacity_kw).toBe(500);
  });
});

describe("calculateCostBenefit", () => {
  it("returns positive net benefit for a viable project", () => {
    const result = calculateCostBenefit(BASE_INPUT);
    expect(result.total_installation_cost).toBeGreaterThan(0);
    expect(result.total_revenue).toBeGreaterThan(0);
    expect(result.net_benefit).toBeGreaterThan(0);
    expect(result.benefit_cost_ratio).toBeGreaterThan(1);
    expect(result.cash_flows).toHaveLength(26);
  });

  it("year 0 cash flow is negative installation cost minus incentives", () => {
    const result = calculateCostBenefit(BASE_INPUT);
    expect(result.cash_flows[0].year).toBe(0);
    expect(result.cash_flows[0].net_cash_flow).toBeLessThan(0);
  });

  it("final year includes salvage value", () => {
    const result = calculateCostBenefit(BASE_INPUT);
    const finalCF = result.cash_flows[result.cash_flows.length - 1];
    expect(finalCF.year).toBe(25);
    expect(finalCF.net_cash_flow).toBeGreaterThan(0);
  });
});

describe("calculatePaybackPeriod", () => {
  it("returns a positive payback period for viable project", () => {
    const result = calculatePaybackPeriod(BASE_INPUT);
    expect(result.payback_years).toBeGreaterThan(0);
    expect(result.simple_payback_years).toBeGreaterThan(0);
    expect(result.reaches_payback).toBe(true);
    expect(result.cumulative_cash_flow).toHaveLength(26);
  });

  it("discounted payback is longer than simple payback", () => {
    const result = calculatePaybackPeriod(BASE_INPUT);
    expect(result.discounted_payback_years).toBeGreaterThanOrEqual(result.simple_payback_years);
  });

  it("reaches_payback is false for very high cost projects", () => {
    const expensive = createDefaultFinancialInput(500, 80, {
      installation_cost: 50_000_000,
      electricity_price_per_kwh: 0.01,
    });
    const result = calculatePaybackPeriod(expensive);
    expect(result.reaches_payback).toBe(false);
  });
});

describe("calculateNPV", () => {
  it("returns positive NPV for viable project", () => {
    const result = calculateNPV(BASE_INPUT);
    expect(result.npv).toBeGreaterThan(0);
    expect(result.irr).toBeGreaterThan(0);
    expect(result.profitability_index).toBeGreaterThan(1);
  });

  it("NPV is lower with higher discount rate", () => {
    const lowRate = calculateNPV(createDefaultFinancialInput(500, 80, { discount_rate: 0.05 }));
    const highRate = calculateNPV(createDefaultFinancialInput(500, 80, { discount_rate: 0.15 }));
    expect(lowRate.npv).toBeGreaterThan(highRate.npv);
  });

  it("negative NPV for uneconomic project", () => {
    const bad = createDefaultFinancialInput(500, 80, {
      installation_cost: 10_000_000,
      electricity_price_per_kwh: 0.01,
    });
    const result = calculateNPV(bad);
    expect(result.npv).toBeLessThan(0);
  });
});

describe("performSensitivityAnalysis", () => {
  it("returns base case and sensitivity points", () => {
    const result = performSensitivityAnalysis(BASE_INPUT);
    expect(result.base_case.npv).toBeGreaterThan(0);
    expect(result.base_case.payback_years).toBeGreaterThan(0);
    expect(result.sensitivities.length).toBeGreaterThan(0);
  });

  it("higher installation cost reduces NPV", () => {
    const result = performSensitivityAnalysis(BASE_INPUT);
    const costUp20 = result.sensitivities.find((s) => s.label === "Installation Cost +20%");
    const costDown20 = result.sensitivities.find((s) => s.label === "Installation Cost -20%");
    expect(costUp20).toBeDefined();
    expect(costDown20).toBeDefined();
    expect(costUp20!.npv).toBeLessThan(costDown20!.npv);
  });

  it("higher electricity price increases NPV", () => {
    const result = performSensitivityAnalysis(BASE_INPUT);
    const priceUp20 = result.sensitivities.find((s) => s.label === "Electricity Price +20%");
    const priceDown20 = result.sensitivities.find((s) => s.label === "Electricity Price -20%");
    expect(priceUp20).toBeDefined();
    expect(priceDown20).toBeDefined();
    expect(priceUp20!.npv).toBeGreaterThan(priceDown20!.npv);
  });

  it("each parameter type is present", () => {
    const result = performSensitivityAnalysis(BASE_INPUT);
    const parameters = new Set(result.sensitivities.map((s) => s.parameter));
    expect(parameters.has("Installation Cost")).toBe(true);
    expect(parameters.has("Electricity Price")).toBe(true);
    expect(parameters.has("Discount Rate")).toBe(true);
    expect(parameters.has("Degradation Rate")).toBe(true);
    expect(parameters.has("Energy Output")).toBe(true);
  });
});

describe("compareROI", () => {
  it("returns comparison across projects with rankings", () => {
    const project1 = createDefaultFinancialInput(500, 80);
    const project2 = createDefaultFinancialInput(1000, 75);
    const project3 = createDefaultFinancialInput(200, 90);

    const result = compareROI([
      { project_id: 1, input: project1 },
      { project_id: 2, input: project2 },
      { project_id: 3, input: project3 },
    ]);

    expect(result.comparison).toHaveLength(3);
    expect(result.rankings.by_roi).toHaveLength(3);
    expect(result.rankings.by_npv).toHaveLength(3);
    expect(result.rankings.by_irr).toHaveLength(3);
    expect(result.rankings.by_payback).toHaveLength(3);
  });

  it("ranks by ROI descending", () => {
    const result = compareROI([
      { project_id: 1, input: createDefaultFinancialInput(500, 80, { installation_cost: 100_000 }) },
      { project_id: 2, input: createDefaultFinancialInput(500, 80, { installation_cost: 1_000_000 }) },
    ]);
    expect(result.rankings.by_roi[0].project_id).toBe(1);
    expect(result.rankings.by_roi[0].roi_pct).toBeGreaterThan(result.rankings.by_roi[1].roi_pct);
  });

  it("ranks by payback ascending", () => {
    const result = compareROI([
      { project_id: 1, input: createDefaultFinancialInput(500, 80, { installation_cost: 100_000 }) },
      { project_id: 2, input: createDefaultFinancialInput(500, 80, { installation_cost: 1_000_000 }) },
    ]);
    expect(result.rankings.by_payback[0].payback_years).toBeLessThanOrEqual(
      result.rankings.by_payback[1].payback_years,
    );
  });
});

describe("financial API routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("GET /api/financial/cost-benefit/:id — returns cost/benefit analysis", async () => {
    const res = await request(app)
      .get("/api/financial/cost-benefit/1")
      .expect(200);
    expect(res.body).toHaveProperty("total_installation_cost");
    expect(res.body).toHaveProperty("total_revenue");
    expect(res.body).toHaveProperty("net_benefit");
    expect(res.body).toHaveProperty("benefit_cost_ratio");
    expect(res.body).toHaveProperty("cash_flows");
    expect(res.body.cash_flows).toHaveLength(26);
  });

  it("GET /api/financial/cost-benefit/:id — 400 for invalid id", async () => {
    const res = await request(app)
      .get("/api/financial/cost-benefit/abc")
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("GET /api/financial/payback/:id — returns payback period", async () => {
    const res = await request(app)
      .get("/api/financial/payback/1")
      .expect(200);
    expect(res.body).toHaveProperty("payback_years");
    expect(res.body).toHaveProperty("simple_payback_years");
    expect(res.body).toHaveProperty("discounted_payback_years");
    expect(res.body).toHaveProperty("cumulative_cash_flow");
    expect(res.body).toHaveProperty("reaches_payback");
    expect(res.body.payback_years).toBeGreaterThan(0);
  });

  it("GET /api/financial/npv/:id — returns NPV calculation", async () => {
    const res = await request(app)
      .get("/api/financial/npv/1")
      .expect(200);
    expect(res.body).toHaveProperty("npv");
    expect(res.body).toHaveProperty("irr");
    expect(res.body).toHaveProperty("profitability_index");
    expect(res.body).toHaveProperty("discounted_cash_flows");
    expect(res.body.npv).toBeGreaterThan(0);
  });

  it("GET /api/financial/sensitivity/:id — returns sensitivity analysis", async () => {
    const res = await request(app)
      .get("/api/financial/sensitivity/1")
      .expect(200);
    expect(res.body).toHaveProperty("base_case");
    expect(res.body).toHaveProperty("sensitivities");
    expect(res.body.base_case).toHaveProperty("npv");
    expect(res.body.sensitivities.length).toBeGreaterThan(0);
    expect(res.body.sensitivities[0]).toHaveProperty("parameter");
    expect(res.body.sensitivities[0]).toHaveProperty("change");
    expect(res.body.sensitivities[0]).toHaveProperty("npv");
    expect(res.body.sensitivities[0]).toHaveProperty("payback_years");
  });

  it("GET /api/financial/roi-comparison — compares ROI across projects", async () => {
    const res = await request(app)
      .get("/api/financial/roi-comparison?ids=1,2,3")
      .expect(200);
    expect(res.body).toHaveProperty("comparison");
    expect(res.body).toHaveProperty("rankings");
    expect(res.body.comparison).toHaveLength(3);
    expect(res.body.rankings).toHaveProperty("by_roi");
    expect(res.body.rankings).toHaveProperty("by_npv");
    expect(res.body.rankings).toHaveProperty("by_irr");
    expect(res.body.rankings).toHaveProperty("by_payback");
  });

  it("GET /api/financial/roi-comparison — 400 for missing ids", async () => {
    const res = await request(app)
      .get("/api/financial/roi-comparison")
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("GET /api/financial/roi-comparison — 400 for invalid id", async () => {
    const res = await request(app)
      .get("/api/financial/roi-comparison?ids=abc")
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("accepts optional query parameters to override defaults", async () => {
    const res = await request(app)
      .get("/api/financial/npv/1?installation_cost=800000&discount_rate=0.05")
      .expect(200);
    expect(res.body).toHaveProperty("npv");
    expect(res.body.npv).toBeGreaterThan(0);
  });

  it("GET /api/financial/payback/:id — accepts parameter overrides", async () => {
    const res = await request(app)
      .get("/api/financial/payback/1?installation_cost=10000000&electricity_price_per_kwh=0.05")
      .expect(200);
    expect(res.body.reaches_payback).toBe(false);
  });

  it("GET /api/financial/sensitivity/:id — overrides affect base case", async () => {
    const res = await request(app)
      .get("/api/financial/sensitivity/1?installation_cost=100000")
      .expect(200);
    expect(res.body.base_case.npv).toBeGreaterThan(0);
  });

  it("GET /api/financial/roi-comparison — 400 for too many ids", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => i + 1).join(",");
    const res = await request(app)
      .get(`/api/financial/roi-comparison?ids=${ids}`)
      .expect(400);
    expect(res.body.error).toBe("bad_request");
  });
});
