export interface FinancialInput {
  system_capacity_kw: number;
  installation_cost: number;
  annual_maintenance_cost: number;
  annual_energy_output_kwh: number;
  electricity_price_per_kwh: number;
  degradation_rate: number;
  discount_rate: number;
  inflation_rate: number;
  project_lifetime_years: number;
  tax_incentives: number;
  salvage_value: number;
  capacity_factor: number;
}

export interface DiscountedCashFlow {
  year: number;
  energy_output_kwh: number;
  revenue: number;
  maintenance_cost: number;
  net_cash_flow: number;
  discounted_cash_flow: number;
  cumulative_discounted_cash_flow: number;
}

export interface CostBenefitResult {
  total_installation_cost: number;
  total_maintenance_cost: number;
  total_operating_cost: number;
  total_cost: number;
  total_revenue: number;
  tax_incentives: number;
  salvage_value: number;
  net_benefit: number;
  benefit_cost_ratio: number;
  cash_flows: DiscountedCashFlow[];
}

export interface PaybackPeriodResult {
  payback_years: number;
  simple_payback_years: number;
  discounted_payback_years: number;
  cumulative_cash_flow: { year: number; cumulative_net: number }[];
  reaches_payback: boolean;
}

export interface NPVResult {
  npv: number;
  irr: number;
  profitability_index: number;
  total_present_value_benefits: number;
  total_present_value_costs: number;
  discounted_cash_flows: DiscountedCashFlow[];
}

export interface SensitivityPoint {
  label: string;
  parameter: string;
  change: string;
  multiplier: number;
  npv: number;
  payback_years: number;
  irr: number;
}

export interface SensitivityResult {
  base_case: {
    npv: number;
    payback_years: number;
    irr: number;
  };
  sensitivities: SensitivityPoint[];
}

export interface ProjectROI {
  project_id: number;
  roi_pct: number;
  npv: number;
  irr: number;
  payback_years: number;
  benefit_cost_ratio: number;
}

export interface ROIComparisonResult {
  comparison: ProjectROI[];
  rankings: {
    by_roi: ProjectROI[];
    by_npv: ProjectROI[];
    by_irr: ProjectROI[];
    by_payback: ProjectROI[];
  };
}

function round(n: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function buildCashFlows(input: FinancialInput): DiscountedCashFlow[] {
  const {
    installation_cost,
    annual_maintenance_cost,
    annual_energy_output_kwh,
    electricity_price_per_kwh,
    degradation_rate,
    discount_rate,
    inflation_rate,
    project_lifetime_years,
    salvage_value,
    tax_incentives,
  } = input;

  const cashFlows: DiscountedCashFlow[] = [];
  const realDiscountRate = (1 + discount_rate) / (1 + inflation_rate) - 1;

  for (let year = 0; year <= project_lifetime_years; year++) {
    if (year === 0) {
      const netCF = -(installation_cost - tax_incentives);
      const dcf = netCF;
      cashFlows.push({
        year: 0,
        energy_output_kwh: 0,
        revenue: 0,
        maintenance_cost: 0,
        net_cash_flow: round(netCF),
        discounted_cash_flow: round(dcf),
        cumulative_discounted_cash_flow: round(dcf),
      });
      continue;
    }

    const degradedOutput = annual_energy_output_kwh * Math.pow(1 - degradation_rate, year - 1);
    const inflatedPrice = electricity_price_per_kwh * Math.pow(1 + inflation_rate, year - 1);
    const revenue = degradedOutput * inflatedPrice;
    const maintenanceCost = annual_maintenance_cost * Math.pow(1 + inflation_rate, year - 1);
    let netCF = revenue - maintenanceCost;
    if (year === project_lifetime_years) {
      netCF += salvage_value;
    }
    const dcf = netCF / Math.pow(1 + realDiscountRate, year);
    const prevCumulative = cashFlows[year - 1]?.cumulative_discounted_cash_flow ?? 0;

    cashFlows.push({
      year,
      energy_output_kwh: round(degradedOutput),
      revenue: round(revenue),
      maintenance_cost: round(maintenanceCost),
      net_cash_flow: round(netCF),
      discounted_cash_flow: round(dcf),
      cumulative_discounted_cash_flow: round(prevCumulative + dcf),
    });
  }

  return cashFlows;
}

function calculateIRR(cashFlows: number[], guess = 0.1): number {
  const maxIterations = 1000;
  const tolerance = 1e-7;
  let rate = guess;

  for (let i = 0; i < maxIterations; i++) {
    let npv = 0;
    let dnpv = 0;
    for (let t = 0; t < cashFlows.length; t++) {
      npv += cashFlows[t] / Math.pow(1 + rate, t);
      dnpv += -t * cashFlows[t] / Math.pow(1 + rate, t + 1);
    }
    if (Math.abs(npv) < tolerance) {
      return round(rate, 4);
    }
    if (dnpv === 0) break;
    rate = rate - npv / dnpv;
  }
  return NaN;
}

export function createDefaultFinancialInput(
  capacityKw: number,
  _efficiencyPct: number,
  partial?: Partial<FinancialInput>,
): FinancialInput {
  const capacityFactor = 0.20;
  const annualEnergy = capacityKw * 8760 * capacityFactor;
  const installationCostPerKw = 1000;
  const maintenancePerKwPerYear = 15;

  const defaults = {
    system_capacity_kw: capacityKw,
    installation_cost: capacityKw * installationCostPerKw,
    annual_maintenance_cost: capacityKw * maintenancePerKwPerYear,
    annual_energy_output_kwh: annualEnergy,
    electricity_price_per_kwh: 0.10,
    degradation_rate: 0.005,
    discount_rate: 0.07,
    inflation_rate: 0.02,
    project_lifetime_years: 25,
    tax_incentives: capacityKw * installationCostPerKw * 0.30,
    salvage_value: capacityKw * installationCostPerKw * 0.10,
    capacity_factor: capacityFactor,
  };

  const merged = { ...defaults, ...partial };

  const finalInstallCost = merged.installation_cost;
  if (partial?.tax_incentives === undefined) {
    merged.tax_incentives = finalInstallCost * 0.30;
  }
  if (partial?.salvage_value === undefined) {
    merged.salvage_value = finalInstallCost * 0.10;
  }

  return merged;
}

export function calculateCostBenefit(input: FinancialInput): CostBenefitResult {
  const cashFlows = buildCashFlows(input);
  const operatingCashFlows = cashFlows.filter((cf) => cf.year > 0);

  const totalRevenue = round(operatingCashFlows.reduce((sum, cf) => sum + cf.revenue, 0));
  const totalMaintenance = round(operatingCashFlows.reduce((sum, cf) => sum + cf.maintenance_cost, 0));
  const totalInstallation = input.installation_cost;
  const totalOperating = totalMaintenance;
  const totalCost = round(totalInstallation + totalOperating);
  const netBenefit = round(totalRevenue + input.salvage_value + input.tax_incentives - totalCost);
  const benefitCostRatio = round(
    (totalRevenue + input.salvage_value + input.tax_incentives) / totalCost,
  );

  return {
    total_installation_cost: round(totalInstallation),
    total_maintenance_cost: round(totalMaintenance),
    total_operating_cost: round(totalOperating),
    total_cost: totalCost,
    total_revenue: totalRevenue,
    tax_incentives: input.tax_incentives,
    salvage_value: input.salvage_value,
    net_benefit: netBenefit,
    benefit_cost_ratio: benefitCostRatio,
    cash_flows: cashFlows,
  };
}

export function calculatePaybackPeriod(input: FinancialInput): PaybackPeriodResult {
  const cashFlows = buildCashFlows(input);
  const netCashFlows = cashFlows.map((cf) => cf.net_cash_flow);
  const discountedCashFlows = cashFlows.map((cf) => cf.discounted_cash_flow);

  const cumulative: { year: number; cumulative_net: number }[] = [];
  let cumNet = 0;

  for (let i = 0; i < netCashFlows.length; i++) {
    cumNet += netCashFlows[i];
    cumulative.push({ year: i, cumulative_net: round(cumNet) });
  }

  let simplePaybackYears = 0;
  let cum = 0;
  for (let i = 0; i < netCashFlows.length; i++) {
    cum += netCashFlows[i];
    if (cum >= 0) {
      const prevCum = cum - netCashFlows[i];
      if (netCashFlows[i] !== 0) {
        simplePaybackYears = (i - 1) + Math.abs(prevCum) / netCashFlows[i];
      } else {
        simplePaybackYears = i;
      }
      break;
    }
  }

  let discountedPaybackYears = 0;
  let discCum = 0;
  for (let i = 0; i < discountedCashFlows.length; i++) {
    discCum += discountedCashFlows[i];
    if (discCum >= 0) {
      const prevDiscCum = discCum - discountedCashFlows[i];
      if (discountedCashFlows[i] !== 0) {
        discountedPaybackYears = (i - 1) + Math.abs(prevDiscCum) / discountedCashFlows[i];
      } else {
        discountedPaybackYears = i;
      }
      break;
    }
  }

  return {
    payback_years: round(simplePaybackYears),
    simple_payback_years: round(simplePaybackYears),
    discounted_payback_years: round(discountedPaybackYears),
    cumulative_cash_flow: cumulative,
    reaches_payback: simplePaybackYears > 0 && simplePaybackYears < input.project_lifetime_years,
  };
}

export function calculateNPV(input: FinancialInput): NPVResult {
  const cashFlows = buildCashFlows(input);
  const netCFs = cashFlows.map((cf) => cf.net_cash_flow);
  const discountedCFs = cashFlows.map((cf) => cf.discounted_cash_flow);

  const npv = round(discountedCFs.reduce((sum, cf) => sum + cf, 0));

  const irr = calculateIRR(netCFs);

  const totalPVBenefits = round(
    discountedCFs.filter((_, i) => i > 0).reduce((sum, cf) => sum + cf, 0),
  );
  const totalPVCosts = round(Math.abs(discountedCFs[0]));

  const profitabilityIndex = totalPVCosts > 0 ? round(totalPVBenefits / totalPVCosts) : 0;

  return {
    npv,
    irr: isNaN(irr) ? 0 : round(irr * 100, 2),
    profitability_index: profitabilityIndex,
    total_present_value_benefits: totalPVBenefits,
    total_present_value_costs: totalPVCosts,
    discounted_cash_flows: cashFlows,
  };
}

type SensitivityParam = {
  key: keyof FinancialInput;
  label: string;
  variations: { label: string; multiplier: number }[];
};

const SENSITIVITY_PARAMS: SensitivityParam[] = [
  {
    key: "installation_cost",
    label: "Installation Cost",
    variations: [
      { label: "-20%", multiplier: 0.80 },
      { label: "-10%", multiplier: 0.90 },
      { label: "+10%", multiplier: 1.10 },
      { label: "+20%", multiplier: 1.20 },
    ],
  },
  {
    key: "electricity_price_per_kwh",
    label: "Electricity Price",
    variations: [
      { label: "-20%", multiplier: 0.80 },
      { label: "-10%", multiplier: 0.90 },
      { label: "+10%", multiplier: 1.10 },
      { label: "+20%", multiplier: 1.20 },
    ],
  },
  {
    key: "discount_rate",
    label: "Discount Rate",
    variations: [
      { label: "-2%", multiplier: (1 / 0.07) * 0.05 },
      { label: "-1%", multiplier: (1 / 0.07) * 0.06 },
      { label: "+1%", multiplier: (1 / 0.07) * 0.08 },
      { label: "+2%", multiplier: (1 / 0.07) * 0.09 },
    ],
  },
  {
    key: "degradation_rate",
    label: "Degradation Rate",
    variations: [
      { label: "-0.25%", multiplier: 0.5 },
      { label: "+0.25%", multiplier: 1.5 },
      { label: "+0.50%", multiplier: 2.0 },
    ],
  },
  {
    key: "annual_energy_output_kwh",
    label: "Energy Output",
    variations: [
      { label: "-20%", multiplier: 0.80 },
      { label: "-10%", multiplier: 0.90 },
      { label: "+10%", multiplier: 1.10 },
      { label: "+20%", multiplier: 1.20 },
    ],
  },
];

export function performSensitivityAnalysis(input: FinancialInput): SensitivityResult {
  const baseNPV = calculateNPV(input);
  const basePayback = calculatePaybackPeriod(input);

  const baseCase = {
    npv: baseNPV.npv,
    payback_years: basePayback.payback_years,
    irr: baseNPV.irr,
  };

  const sensitivities: SensitivityPoint[] = [];

  for (const param of SENSITIVITY_PARAMS) {
    for (const variation of param.variations) {
      let variedInput: FinancialInput;
      if (param.key === "discount_rate") {
        variedInput = { ...input, [param.key]: input[param.key] * variation.multiplier };
      } else {
        variedInput = { ...input, [param.key]: (input[param.key] as number) * variation.multiplier };
      }
      const npvResult = calculateNPV(variedInput);
      const paybackResult = calculatePaybackPeriod(variedInput);

      sensitivities.push({
        label: `${param.label} ${variation.label}`,
        parameter: param.label,
        change: variation.label,
        multiplier: variation.multiplier,
        npv: npvResult.npv,
        payback_years: paybackResult.payback_years,
        irr: npvResult.irr,
      });
    }
  }

  return { base_case: baseCase, sensitivities };
}

function calculateProjectROI(projectId: number, input: FinancialInput): ProjectROI {
  const npvResult = calculateNPV(input);
  const paybackResult = calculatePaybackPeriod(input);
  const costBenefit = calculateCostBenefit(input);

  const totalInvestment = input.installation_cost - input.tax_incentives;
  const totalNetReturn = costBenefit.net_benefit;
  const roiPct = totalInvestment > 0 ? round((totalNetReturn / totalInvestment) * 100) : 0;

  return {
    project_id: projectId,
    roi_pct: roiPct,
    npv: npvResult.npv,
    irr: npvResult.irr,
    payback_years: paybackResult.payback_years,
    benefit_cost_ratio: costBenefit.benefit_cost_ratio,
  };
}

export function compareROI(projects: { project_id: number; input: FinancialInput }[]): ROIComparisonResult {
  const all = projects.map((p) => calculateProjectROI(p.project_id, p.input));

  const byROI = [...all].sort((a, b) => b.roi_pct - a.roi_pct);
  const byNPV = [...all].sort((a, b) => b.npv - a.npv);
  const byIRR = [...all].sort((a, b) => b.irr - a.irr);
  const byPayback = [...all].sort((a, b) => a.payback_years - b.payback_years);

  return {
    comparison: all,
    rankings: {
      by_roi: byROI,
      by_npv: byNPV,
      by_irr: byIRR,
      by_payback: byPayback,
    },
  };
}
