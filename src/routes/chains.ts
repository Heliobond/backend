import { Router, Request, Response, NextFunction } from "express";
import {
  getChains,
  getEnabledChains,
  getChain,
  configureChain,
  broadcastToChains,
  ChainId,
} from "../lib/multichain";
import { parseProjectId } from "../middleware/errors";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores from "../lib/scoring";

const router = Router();

/** GET /v1/chains — list all configured chains */
router.get("/", (_req: Request, res: Response) => {
  res.json({ chains: getChains(), enabled: getEnabledChains().map((c) => c.id) });
});

/** GET /v1/chains/:id — get chain config */
router.get("/:id", (req: Request, res: Response) => {
  const chain = getChain(req.params.id as ChainId);
  if (!chain) return res.status(404).json({ error: "chain not found" });
  res.json(chain);
});

/** PATCH /v1/chains/:id — update chain config (enable/disable, rpcUrl, contractAddress) */
router.patch("/:id", (req: Request, res: Response) => {
  const { enabled, rpcUrl, contractAddress, name } = req.body as {
    enabled?: boolean;
    rpcUrl?: string;
    contractAddress?: string;
    name?: string;
  };
  const ok = configureChain(req.params.id as ChainId, { enabled, rpcUrl, contractAddress, name });
  if (!ok) return res.status(404).json({ error: "chain not found" });
  res.json({ ok: true, chain: getChain(req.params.id as ChainId) });
});

/***
 * POST /v1/chains/broadcast/:projectId
 * Submit score update to one or more chains.
 * Body: { chains?: string[] } — defaults to all enabled chains.
 */
router.post("/broadcast/:projectId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = parseProjectId(req.params.projectId, "project id");
    const { chains } = req.body as { chains?: string[] };

    // Only Stellar has a real cross-chain submission implemented.
    // EVM chains are not yet supported; return a clear error instead of
    // fabricating a fake transaction hash.
    const targetChains = (chains ?? getEnabledChains().map((c) => c.id)) as ChainId[];
    if (targetChains.some((id) => id !== "stellar")) {
      return res.status(501).json({ error: "EVM chain submission not implemented; only Stellar is currently supported." });
    }

    const solar = getSolarData(projectId);
    const satellite = getSatelliteData(projectId);
    const scores = computeScores({ solar, satellite });

    const result = await broadcastToChains(
      projectId,
      scores.credit_quality,
      scores.green_impact,
      targetChains.length > 0 ? targetChains : undefined,
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
