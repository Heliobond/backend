import { Router, Request, Response, NextFunction } from "express";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { updateImpactScore, getTotalProjects } from "../lib/registry";

const router = Router();

// Bearer token auth — enforced when ADMIN_API_KEY env var is set
router.use((req: Request, res: Response, next: NextFunction) => {
  const apiKey = process.env.ADMIN_API_KEY;
  if (!apiKey) return next();
  if (req.headers.authorization !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// POST /api/admin/update-scores
// Body: { project_ids?: number[] }  — defaults to all projects
// Returns: { updated: number, results: [...], errors: [...] }
router.post("/update-scores", async (req: Request, res: Response) => {
  try {
    let projectIds: number[];

    if (Array.isArray(req.body?.project_ids) && req.body.project_ids.length > 0) {
      projectIds = req.body.project_ids as number[];
    } else {
      const total = await getTotalProjects();
      projectIds = Array.from({ length: total }, (_, i) => i + 1);
    }

    const results: Array<{
      project_id: number;
      tx_hash: string;
      credit_quality: number;
      green_impact: number;
    }> = [];
    const errors: Array<{ project_id: number; error: string }> = [];

    // Soroban does not support multi-call batching — submit sequentially
    for (const projectId of projectIds) {
      try {
        const solar = getSolarData(projectId);
        const satellite = getSatelliteData(projectId);
        const scores = computeScores({ solar, satellite });
        const tx_hash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact);
        results.push({ project_id: projectId, tx_hash, ...scores });
        console.log(`[oracle] project ${projectId}: cq=${scores.credit_quality} gi=${scores.green_impact} tx=${tx_hash}`);
      } catch (err) {
        console.error(`[oracle] project ${projectId} failed:`, err);
        errors.push({ project_id: projectId, error: String(err) });
      }
    }

    res.json({ updated: results.length, results, errors });
  } catch (error) {
    console.error("[oracle] failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
