import { Router, Request, Response, NextFunction } from "express";
import { getSolarData } from "./iot";
import { getTotalProjects } from "../lib/registry";
import {
  createDefaultFinancialInput,
  calculateCostBenefit,
  calculatePaybackPeriod,
  calculateNPV,
  performSensitivityAnalysis,
  compareROI,
} from "../lib/financial";
import { badRequest, parseProjectId, parseOptionalInt } from "../middleware/errors";

const router = Router();

function parseOptionalFloat(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
}

function buildFinancialInput(projectId: number, req: Request) {
  const solar = getSolarData(projectId);
  const capacityKw = parseOptionalFloat(req.query.capacity_kw as string, "capacity_kw") ?? solar.max_power_kw;
  const efficiencyPct = parseOptionalFloat(req.query.efficiency_pct as string, "efficiency_pct") ?? solar.efficiency_pct;

  const overrides: Record<string, number | undefined> = {
    installation_cost: parseOptionalFloat(req.query.installation_cost as string, "installation_cost"),
    annual_maintenance_cost: parseOptionalFloat(req.query.annual_maintenance_cost as string, "annual_maintenance_cost"),
    annual_energy_output_kwh: parseOptionalFloat(req.query.annual_energy_output_kwh as string, "annual_energy_output_kwh"),
    electricity_price_per_kwh: parseOptionalFloat(req.query.electricity_price_per_kwh as string, "electricity_price_per_kwh"),
    degradation_rate: parseOptionalFloat(req.query.degradation_rate as string, "degradation_rate"),
    discount_rate: parseOptionalFloat(req.query.discount_rate as string, "discount_rate"),
    inflation_rate: parseOptionalFloat(req.query.inflation_rate as string, "inflation_rate"),
    project_lifetime_years: parseOptionalFloat(req.query.project_lifetime_years as string, "project_lifetime_years"),
    tax_incentives: parseOptionalFloat(req.query.tax_incentives as string, "tax_incentives"),
    salvage_value: parseOptionalFloat(req.query.salvage_value as string, "salvage_value"),
    capacity_factor: parseOptionalFloat(req.query.capacity_factor as string, "capacity_factor"),
  };

  const filteredOverrides: Partial<typeof overrides> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (filteredOverrides as Record<string, number>)[key] = value;
    }
  }

  return createDefaultFinancialInput(capacityKw, efficiencyPct, filteredOverrides);
}

router.get("/cost-benefit/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const input = buildFinancialInput(id, req);
    const result = calculateCostBenefit(input);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/payback/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const input = buildFinancialInput(id, req);
    const result = calculatePaybackPeriod(input);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/npv/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const input = buildFinancialInput(id, req);
    const result = calculateNPV(input);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/sensitivity/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const input = buildFinancialInput(id, req);
    const result = performSensitivityAnalysis(input);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/roi-comparison", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idsRaw = req.query.ids as string | undefined;
    if (!idsRaw) throw badRequest("ids query parameter is required (comma-separated)");
    const ids = idsRaw.split(",").map((s) => {
      const n = Number(s.trim());
      if (!Number.isInteger(n) || n < 1) throw badRequest(`Invalid project id "${s.trim()}"`);
      return n;
    });
    if (ids.length === 0) throw badRequest("At least one project id is required");
    if (ids.length > 20) throw badRequest("Cannot compare more than 20 projects at once");

    const projects = ids.map((id) => ({
      project_id: id,
      input: buildFinancialInput(id, req),
    }));

    const result = compareROI(projects);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
