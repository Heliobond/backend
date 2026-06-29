import { Router, Request, Response, NextFunction } from "express";
import { getTotalProjects } from "../lib/registry";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { createDefaultFinancialInput, calculateNPV, calculatePaybackPeriod } from "../lib/financial";
import { getAuditLog } from "../lib/audit";
import { badRequest } from "../middleware/errors";

const router = Router();

// Helper to collect all project details deterministically
async function getPortfolioData() {
  const total = await getTotalProjects();
  const ids = Array.from({ length: total }, (_, i) => i + 1);

  return ids.map((id) => {
    const solar = getSolarData(id);
    const satellite = getSatelliteData(id);
    const scores = computeScores({ solar, satellite });
    // Deterministic funding based on project ID
    const funding = 250000 + (id * 150000) % 600000;
    // Expected output based on capacity factor
    const expected_output = solar.max_power_kw * 24 * 365 * 0.2; // 20% capacity factor
    const actual_output = solar.power_output_kw * 24 * 365 * 0.2;
    const actual_vs_expected_ratio = Math.min(1.2, Math.max(0.5, actual_output / expected_output));

    return {
      id,
      solar,
      satellite,
      scores,
      funding,
      actual_vs_expected_ratio,
    };
  });
}

// GET /dashboard — Investor Dashboard Data
router.get("/dashboard", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const portfolio = await getPortfolioData();
    if (portfolio.length === 0) {
      return res.json({
        portfolio_summary: {
          total_projects: 0,
          total_power_output_kw: 0,
          avg_credit_quality: 0,
          avg_green_impact: 0,
          total_portfolio_value: 0,
          total_carbon_offsets_tonnes: 0,
        },
        recent_activities: [],
      });
    }

    const totalPower = portfolio.reduce((acc, p) => acc + p.solar.power_output_kw, 0);
    const totalCreditQuality = portfolio.reduce((acc, p) => acc + p.scores.credit_quality, 0);
    const totalGreenImpact = portfolio.reduce((acc, p) => acc + p.scores.green_impact, 0);
    const totalFunding = portfolio.reduce((acc, p) => acc + p.funding, 0);
    // Formula for carbon offsets: power_output_kw * green_impact * constant factor
    const totalCarbonOffsets = portfolio.reduce(
      (acc, p) => acc + p.solar.power_output_kw * p.scores.green_impact * 0.05,
      0
    );

    const recentAuditLogs = getAuditLog().slice(-5).reverse();

    res.json({
      portfolio_summary: {
        total_projects: portfolio.length,
        total_power_output_kw: Math.round(totalPower * 100) / 100,
        avg_credit_quality: Math.round((totalCreditQuality / portfolio.length) * 100) / 100,
        avg_green_impact: Math.round((totalGreenImpact / portfolio.length) * 100) / 100,
        total_portfolio_value: totalFunding,
        total_carbon_offsets_tonnes: Math.round(totalCarbonOffsets * 100) / 100,
      },
      recent_activities: recentAuditLogs,
    });
  } catch (error) {
    next(error);
  }
});

// GET /performance-report — Performance Reports
router.get("/performance-report", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const portfolio = await getPortfolioData();
    const reports = portfolio.map((p) => {
      let status: "Optimal" | "Underperforming" | "Critical" = "Optimal";
      if (p.actual_vs_expected_ratio < 0.8) {
        status = "Critical";
      } else if (p.actual_vs_expected_ratio < 0.95) {
        status = "Underperforming";
      }

      return {
        project_id: p.id,
        efficiency_pct: p.solar.efficiency_pct,
        power_output_kw: p.solar.power_output_kw,
        ndvi_score: p.satellite.ndvi_score,
        actual_vs_expected_ratio: Math.round(p.actual_vs_expected_ratio * 100) / 100,
        performance_status: status,
      };
    });

    res.json({
      generated_at: Date.now(),
      projects: reports,
    });
  } catch (error) {
    next(error);
  }
});

// GET /financial-summary — Financial Summaries
router.get("/financial-summary", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const portfolio = await getPortfolioData();
    const projectFinancials = portfolio.map((p) => {
      const input = createDefaultFinancialInput(p.solar.max_power_kw, p.solar.efficiency_pct);
      const npvResult = calculateNPV(input);
      const paybackResult = calculatePaybackPeriod(input);

      // ROI = Net benefit over lifetime / installation cost
      const lifetimeYears = input.project_lifetime_years;
      const totalBenefits = npvResult.discounted_cash_flows.reduce((acc, cf) => acc + cf.revenue, 0);
      const totalOpsCosts = npvResult.discounted_cash_flows.reduce((acc, cf) => acc + cf.maintenance_cost, 0);
      const netBenefits = totalBenefits - totalOpsCosts + (input.salvage_value ?? 0);
      const roi = input.installation_cost > 0 ? (netBenefits - input.installation_cost) / input.installation_cost : 0;

      return {
        project_id: p.id,
        installation_cost: Math.round(input.installation_cost * 100) / 100,
        npv: Math.round(npvResult.npv * 100) / 100,
        payback_period_years: paybackResult.reaches_payback ? Math.round(paybackResult.payback_years * 10) / 10 : null,
        roi_pct: Math.round(roi * 1000) / 10,
      };
    });

    if (projectFinancials.length === 0) {
      return res.json({
        portfolio_financials: {
          total_installation_cost: 0,
          total_npv: 0,
          avg_payback_period_years: null,
          avg_roi_pct: 0,
        },
        projects: [],
      });
    }

    const totalCost = projectFinancials.reduce((acc, p) => acc + p.installation_cost, 0);
    const totalNpv = projectFinancials.reduce((acc, p) => acc + p.npv, 0);
    const validPaybacks = projectFinancials.filter((p) => p.payback_period_years !== null) as Array<typeof projectFinancials[0] & { payback_period_years: number }>;
    const avgPayback = validPaybacks.length > 0 ? validPaybacks.reduce((acc, p) => acc + p.payback_period_years, 0) / validPaybacks.length : null;
    const avgRoi = projectFinancials.reduce((acc, p) => acc + p.roi_pct, 0) / projectFinancials.length;

    res.json({
      portfolio_financials: {
        total_installation_cost: Math.round(totalCost * 100) / 100,
        total_npv: Math.round(totalNpv * 100) / 100,
        avg_payback_period_years: avgPayback !== null ? Math.round(avgPayback * 10) / 10 : null,
        avg_roi_pct: Math.round(avgRoi * 10) / 10,
      },
      projects: projectFinancials,
    });
  } catch (error) {
    next(error);
  }
});

// GET /compliance-report — Compliance Reports
router.get("/compliance-report", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const portfolio = await getPortfolioData();
    const reports = portfolio.map((p) => {
      // ESG status based on credit quality and green impact
      const score = (p.scores.credit_quality + p.scores.green_impact) / 2;
      let status: "Compliant" | "Warning" | "Non-Compliant" = "Compliant";
      if (score < 50) {
        status = "Non-Compliant";
      } else if (score < 70) {
        status = "Warning";
      }

      // Carbon credits: simulated registry entry
      const carbonCredits = Math.round(p.solar.power_output_kw * p.scores.green_impact * 0.5);

      return {
        project_id: p.id,
        green_impact: p.scores.green_impact,
        ndvi_score: p.satellite.ndvi_score,
        carbon_credits_issued: carbonCredits,
        compliance_status: status,
      };
    });

    const totalCredits = reports.reduce((acc, r) => acc + r.carbon_credits_issued, 0);
    const avgGreenImpact = portfolio.length > 0 ? portfolio.reduce((acc, p) => acc + p.scores.green_impact, 0) / portfolio.length : 0;
    
    let portfolioStatus: "Compliant" | "Warning" | "Non-Compliant" = "Compliant";
    if (avgGreenImpact < 50) {
      portfolioStatus = "Non-Compliant";
    } else if (avgGreenImpact < 70) {
      portfolioStatus = "Warning";
    }

    res.json({
      portfolio_compliance: {
        portfolio_esg_score: Math.round(avgGreenImpact * 100) / 100,
        total_carbon_credits_issued: totalCredits,
        portfolio_status: portfolioStatus,
      },
      projects: reports,
      audit_logs: getAuditLog(),
    });
  } catch (error) {
    next(error);
  }
});

// POST /custom-report — Custom Report Generation
router.post("/custom-report", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { project_ids, sections } = req.body;

    if (project_ids !== undefined) {
      if (!Array.isArray(project_ids)) {
        throw badRequest("project_ids must be an array of positive integers");
      }
      if (!project_ids.every((n) => Number.isInteger(n) && n >= 1)) {
        throw badRequest("project_ids must contain only positive integers");
      }
    }

    if (sections !== undefined) {
      if (!Array.isArray(sections)) {
        throw badRequest("sections must be an array of strings");
      }
      const validSections = ["financials", "performance", "compliance", "scores"];
      if (!sections.every((s) => typeof s === "string" && validSections.includes(s))) {
        throw badRequest(`sections must contain only: ${validSections.join(", ")}`);
      }
    }

    const portfolio = await getPortfolioData();
    const filterIds = project_ids as number[] | undefined;
    const filterSections = (sections as string[] | undefined) ?? ["scores"];

    const filteredPortfolio = filterIds
      ? portfolio.filter((p) => filterIds.includes(p.id))
      : portfolio;

    const reportProjects = filteredPortfolio.map((p) => {
      const pReport: any = { project_id: p.id };

      if (filterSections.includes("scores")) {
        pReport.scores = {
          credit_quality: p.scores.credit_quality,
          green_impact: p.scores.green_impact,
        };
      }

      if (filterSections.includes("performance")) {
        let status: "Optimal" | "Underperforming" | "Critical" = "Optimal";
        if (p.actual_vs_expected_ratio < 0.8) {
          status = "Critical";
        } else if (p.actual_vs_expected_ratio < 0.95) {
          status = "Underperforming";
        }

        pReport.performance = {
          efficiency_pct: p.solar.efficiency_pct,
          power_output_kw: p.solar.power_output_kw,
          actual_vs_expected_ratio: Math.round(p.actual_vs_expected_ratio * 100) / 100,
          performance_status: status,
        };
      }

      if (filterSections.includes("financials")) {
        const input = createDefaultFinancialInput(p.solar.max_power_kw, p.solar.efficiency_pct);
        const npvResult = calculateNPV(input);
        const paybackResult = calculatePaybackPeriod(input);

        pReport.financials = {
          installation_cost: Math.round(input.installation_cost * 100) / 100,
          npv: Math.round(npvResult.npv * 100) / 100,
          payback_period_years: paybackResult.reaches_payback ? Math.round(paybackResult.payback_years * 10) / 10 : null,
        };
      }

      if (filterSections.includes("compliance")) {
        const score = (p.scores.credit_quality + p.scores.green_impact) / 2;
        let status: "Compliant" | "Warning" | "Non-Compliant" = "Compliant";
        if (score < 50) {
          status = "Non-Compliant";
        } else if (score < 70) {
          status = "Warning";
        }

        pReport.compliance = {
          green_impact: p.scores.green_impact,
          compliance_status: status,
          carbon_credits_issued: Math.round(p.solar.power_output_kw * p.scores.green_impact * 0.5),
        };
      }

      return pReport;
    });

    res.json({
      generated_at: Date.now(),
      project_count: reportProjects.length,
      projects: reportProjects,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
