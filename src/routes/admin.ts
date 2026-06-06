import { Router, Request, Response } from "express";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { updateImpactScore, getTotalProjects } from "../lib/registry";

const router = Router();

// POST /api/admin/update-scores
// Body: { project_ids?: number[] }  — defaults to all projects
// Returns: { updated: number, results: [{ project_id, tx_hash, credit_quality, green_impact }] }
router.post("/update-scores", async (req: Request, res: Response) => {
  try {
    let projectIds: number[] = req.body?.project_ids;

    if (!projectIds || projectIds.length === 0) {
      const total = await getTotalProjects();
      projectIds = Array.from({ length: total }, (_, i) => i + 1);
    }

    const results: Array<{
      project_id: number;
      tx_hash: string;
      credit_quality: number;
      green_impact: number;
    }> = [];

    // Soroban does not support multi-call batching — submit sequentially
    for (const projectId of projectIds) {
      const solar = getSolarData(projectId);
      const satellite = getSatelliteData(projectId);
      const scores = computeScores({ solar, satellite });
      const tx_hash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact);
      results.push({ project_id: projectId, tx_hash, ...scores });
      console.log(`[oracle] project ${projectId}: cq=${scores.credit_quality} gi=${scores.green_impact} tx=${tx_hash}`);
    }

    res.json({ updated: results.length, results });
  } catch (error) {
    console.error("[oracle] failed:", error);
    res.status(500).json({ error: String(error) });
  }
});

export default router;
