import { Router, Request, Response, NextFunction } from "express";
import {
  createFormula,
  listFormulas,
  getFormula,
  setActiveFormula,
  deleteFormula,
  getActiveFormula,
  computeScoresWithFormula,
  validateWeights,
} from "../lib/scoring-formula";
import { getSolarData, getSatelliteData } from "./iot";
import { parseProjectId, badRequest } from "../middleware/errors";

const router = Router();

/** GET /v1/scoring/formulas — list all formulas */
router.get("/", (_req: Request, res: Response) => {
  res.json({ formulas: listFormulas(), active: getActiveFormula()?.id ?? null });
});

/** POST /v1/scoring/formulas — create a new formula */
router.post("/", (req: Request, res: Response) => {
  const { id, name, description, weights } = req.body as {
    id?: string;
    name?: string;
    description?: string;
    weights?: Record<string, number>;
  };

  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "id is required" });
  }
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const result = createFormula(id, name, weights ?? {}, description);
  if (!result.valid) {
    return res.status(400).json({ error: "validation failed", errors: result.errors });
  }

  res.status(201).json(result.formula);
});

/** GET /v1/scoring/formulas/:id — get a formula */
router.get("/:id", (req: Request, res: Response) => {
  const formula = getFormula(String(req.params.id));
  if (!formula) return res.status(404).json({ error: "formula not found" });
  res.json(formula);
});

/** DELETE /v1/scoring/formulas/:id — delete a formula */
router.delete("/:id", (req: Request, res: Response) => {
  const deleted = deleteFormula(String(req.params.id));
  if (!deleted) return res.status(404).json({ error: "formula not found" });
  res.json({ ok: true });
});

/** POST /v1/scoring/formulas/:id/activate — set as active formula */
router.post("/:id/activate", (req: Request, res: Response) => {
  const ok = setActiveFormula(String(req.params.id));
  if (!ok) return res.status(404).json({ error: "formula not found" });
  res.json({ ok: true, active: String(req.params.id) });
});

/** POST /v1/scoring/formulas/validate — validate weights without saving */
router.post("/validate", (req: Request, res: Response) => {
  const { weights } = req.body as { weights?: Record<string, number> };
  if (!weights) return res.status(400).json({ error: "weights required" });
  res.json(validateWeights(weights));
});

/**
 * GET /v1/scoring/formulas/:id/preview/:projectId
 * Preview how a formula changes scores for a project (A/B testing).
 */
router.get("/:id/preview/:projectId", (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = parseProjectId(req.params.projectId, "project id");
    const formula = getFormula(String(req.params.id));
    if (!formula) return res.status(404).json({ error: "formula not found" });

    const solar = getSolarData(projectId);
    const satellite = getSatelliteData(projectId);
    const input = { solar, satellite };

    const withFormula = computeScoresWithFormula(input, formula);
    const withDefault = computeScoresWithFormula(input);

    res.json({
      projectId,
      formula: { id: formula.id, name: formula.name },
      scores: { withFormula, withDefault },
      delta: {
        credit_quality: withFormula.credit_quality - withDefault.credit_quality,
        green_impact: withFormula.green_impact - withDefault.green_impact,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
