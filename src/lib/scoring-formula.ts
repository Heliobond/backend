import type { IotInput, ImpactScores } from "./scoring.js";

export interface ScoringWeights {
  efficiency_weight: number;
  power_weight: number;
  forest_weight: number;
  ndvi_weight: number;
}

export interface ScoringFormula {
  id: string;
  name: string;
  description?: string;
  weights: ScoringWeights;
  active: boolean;
  createdAt: number;
}

export interface FormulaValidationResult {
  valid: boolean;
  errors: string[];
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  efficiency_weight: 1.0,
  power_weight: 0.5,
  forest_weight: 0.5,
  ndvi_weight: 0.5,
};

const formulaStore = new Map<string, ScoringFormula>();
let activeFormulaId: string | null = null;

export function validateWeights(weights: Partial<ScoringWeights>): FormulaValidationResult {
  const errors: string[] = [];
  const keys: (keyof ScoringWeights)[] = ["efficiency_weight", "power_weight", "forest_weight", "ndvi_weight"];

  for (const key of keys) {
    const v = weights[key];
    if (v !== undefined) {
      if (typeof v !== "number" || isNaN(v)) errors.push(`${key} must be a number`);
      else if (v < 0 || v > 10) errors.push(`${key} must be between 0 and 10`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function createFormula(
  id: string,
  name: string,
  weights: Partial<ScoringWeights>,
  description?: string,
): FormulaValidationResult & { formula?: ScoringFormula } {
  const validation = validateWeights(weights);
  if (!validation.valid) return validation;

  const formula: ScoringFormula = {
    id,
    name,
    description,
    weights: { ...DEFAULT_WEIGHTS, ...weights },
    active: false,
    createdAt: Date.now(),
  };
  formulaStore.set(id, formula);
  return { valid: true, errors: [], formula };
}

export function listFormulas(): ScoringFormula[] {
  return Array.from(formulaStore.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getFormula(id: string): ScoringFormula | undefined {
  return formulaStore.get(id);
}

export function setActiveFormula(id: string): boolean {
  if (!formulaStore.has(id)) return false;
  for (const f of formulaStore.values()) f.active = false;
  const formula = formulaStore.get(id)!;
  formula.active = true;
  activeFormulaId = id;
  return true;
}

export function deleteFormula(id: string): boolean {
  if (!formulaStore.has(id)) return false;
  formulaStore.delete(id);
  if (activeFormulaId === id) activeFormulaId = null;
  return true;
}

export function computeScoresWithFormula(input: IotInput, formula?: ScoringFormula): ImpactScores {
  const w = formula?.weights ?? DEFAULT_WEIGHTS;
  const { solar, satellite } = input;

  const efficiencyComponent = solar.efficiency_pct * w.efficiency_weight;
  const powerComponent = (solar.power_output_kw / solar.max_power_kw) * 100 * w.power_weight;
  const forestComponent = satellite.forest_density_pct * w.forest_weight;
  const ndviComponent = satellite.ndvi_score * 100 * w.ndvi_weight;

  const totalWeight = w.efficiency_weight + w.power_weight + w.forest_weight + w.ndvi_weight;

  const credit_quality = Math.round(
    Math.max(0, Math.min(100, (efficiencyComponent + powerComponent) / (w.efficiency_weight + w.power_weight || 1))),
  );

  const green_impact = Math.round(
    Math.max(0, Math.min(100, (forestComponent + ndviComponent) / (w.forest_weight + w.ndvi_weight || 1))),
  );

  void totalWeight;
  return { credit_quality, green_impact };
}

export function getActiveFormula(): ScoringFormula | null {
  if (!activeFormulaId) return null;
  return formulaStore.get(activeFormulaId) ?? null;
}
