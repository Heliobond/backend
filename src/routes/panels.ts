import { Router, Request, Response } from "express";
import {
  setPanelConfig,
  updatePanelConfig,
  getPanelConfig,
  listPanelConfigs,
  effectiveCapacityKw,
  PanelValidationError,
} from "../lib/panels";
import { parseProjectId, badRequest } from "../middleware/errors";

const router = Router();

function present(config: ReturnType<typeof getPanelConfig>) {
  if (!config) return config;
  return { ...config, effective_capacity_kw: effectiveCapacityKw(config) };
}

/** GET /panels — list all configured panel specs. */
router.get("/", (_req: Request, res: Response) => {
  res.json({ panels: listPanelConfigs().map((c) => present(c)) });
});

/** GET /panels/:id — fetch a single project's panel configuration. */
router.get("/:id", (req: Request, res: Response) => {
  const id = parseProjectId(req.params.id, "project id");
  const config = getPanelConfig(id);
  if (!config) {
    res.status(404).json({ error: "not_found", message: "No panel configuration for this project" });
    return;
  }
  res.json(present(config));
});

/** PUT /panels/:id — create or replace a project's panel configuration. */
router.put("/:id", (req: Request, res: Response) => {
  const id = parseProjectId(req.params.id, "project id");
  try {
    const config = setPanelConfig(id, req.body ?? {});
    res.json(present(config));
  } catch (err) {
    if (err instanceof PanelValidationError) throw badRequest(err.message);
    throw err;
  }
});

/** PATCH /panels/:id — partially update an existing configuration. */
router.patch("/:id", (req: Request, res: Response) => {
  const id = parseProjectId(req.params.id, "project id");
  try {
    const config = updatePanelConfig(id, req.body ?? {});
    res.json(present(config));
  } catch (err) {
    if (err instanceof PanelValidationError) throw badRequest(err.message);
    throw err;
  }
});

export default router;
