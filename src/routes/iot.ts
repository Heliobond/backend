import { Router } from "express";
import { parseProjectId } from "../middleware/errors";

const MAX_POWER_KW = 1000;

function seededRandom(seed: number): number {
  const hourSeed = Math.floor(Date.now() / 3_600_000);
  const x = Math.sin(seed * 9301 + hourSeed * 49297 + 233) * 10000;
  return x - Math.floor(x);
}

export function getSolarData(projectId: number) {
  const base = seededRandom(projectId);
  const drift = seededRandom(projectId * 7 + 1);
  const efficiency_pct = Math.min(98, Math.max(40, 40 + base * 58 + drift * 2 - 1));
  const power_output_kw = (efficiency_pct / 100) * MAX_POWER_KW;
  return {
    power_output_kw: Math.round(power_output_kw * 100) / 100,
    efficiency_pct: Math.round(efficiency_pct * 100) / 100,
    max_power_kw: MAX_POWER_KW,
    timestamp: Date.now(),
  };
}

export function getSatelliteData(projectId: number) {
  const base = seededRandom(projectId * 3 + 5);
  const drift = seededRandom(projectId * 11 + 2);
  const forest_density_pct = Math.min(100, Math.max(0, 30 + base * 65 + drift * 5 - 2.5));
  return {
    forest_density_pct: Math.round(forest_density_pct * 100) / 100,
    ndvi_score: Math.round(Math.min(1, forest_density_pct / 100) * 1000) / 1000,
    timestamp: Date.now(),
  };
}

const router = Router();

router.get("/solar/:id", (req, res) => {
  const id = parseProjectId(req.params.id, "project id");
  res.json(getSolarData(id));
});

router.get("/satellite/:id", (req, res) => {
  const id = parseProjectId(req.params.id, "project id");
  res.json(getSatelliteData(id));
});

export default router;
