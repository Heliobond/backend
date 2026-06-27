import { Router, Request, Response } from "express";
import {
  setMetadata,
  updateMetadata,
  getMetadata,
  listMetadata,
  MetadataValidationError,
} from "../lib/metadata";
import { getPanelConfig } from "../lib/panels";
import { parseProjectId, badRequest } from "../middleware/errors";

const router = Router();

function present(projectId: number, meta: ReturnType<typeof getMetadata>) {
  if (!meta) return meta;
  // Surface solar panel specs (#25) alongside descriptive metadata (#24).
  return { ...meta, panel_config: getPanelConfig(projectId) ?? null };
}

/** GET /metadata — list metadata for all projects. */
router.get("/", (_req: Request, res: Response) => {
  res.json({ metadata: listMetadata().map((m) => present(m.project_id, m)) });
});

/** GET /metadata/:id — fetch one project's metadata. */
router.get("/:id", (req: Request, res: Response) => {
  const id = parseProjectId(req.params.id, "project id");
  const meta = getMetadata(id);
  if (!meta) {
    res.status(404).json({ error: "not_found", message: "No metadata for this project" });
    return;
  }
  res.json(present(id, meta));
});

/** PUT /metadata/:id — create or replace project metadata. */
router.put("/:id", (req: Request, res: Response) => {
  const id = parseProjectId(req.params.id, "project id");
  try {
    const meta = setMetadata(id, req.body ?? {});
    res.json(present(id, meta));
  } catch (err) {
    if (err instanceof MetadataValidationError) throw badRequest(err.message);
    throw err;
  }
});

/** PATCH /metadata/:id — partially update project metadata. */
router.patch("/:id", (req: Request, res: Response) => {
  const id = parseProjectId(req.params.id, "project id");
  try {
    const meta = updateMetadata(id, req.body ?? {});
    res.json(present(id, meta));
  } catch (err) {
    if (err instanceof MetadataValidationError) throw badRequest(err.message);
    throw err;
  }
});

export default router;
