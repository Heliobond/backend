import { Router, Request, Response } from "express";
import { assignRole, removeRole, listRoles, type Role } from "../lib/roles";
import { identifyUser, requireAuth, requireRole } from "../middleware/rbac";
import { badRequest } from "../middleware/errors";

const router = Router();

const VALID_ROLES: Role[] = ["admin", "operator", "viewer"];

router.use(identifyUser);

/** POST /api/roles  — assign a role to a user (admin only) */
router.post("/", requireAuth, requireRole("admin"), (req: Request, res: Response) => {
  const { userId, role } = req.body as { userId?: unknown; role?: unknown };
  if (typeof userId !== "string" || !userId.trim()) {
    throw badRequest("userId must be a non-empty string");
  }
  if (!VALID_ROLES.includes(role as Role)) {
    throw badRequest(`role must be one of: ${VALID_ROLES.join(", ")}`);
  }
  assignRole(userId.trim(), role as Role);
  res.status(201).json({ userId: userId.trim(), role });
});

/** GET /api/roles  — list all role assignments (admin only) */
router.get("/", requireAuth, requireRole("admin"), (_req: Request, res: Response) => {
  res.json({ roles: listRoles() });
});

/** DELETE /api/roles/:userId  — revoke a user's role (admin only) */
router.delete("/:userId", requireAuth, requireRole("admin"), (req: Request, res: Response) => {
  const removed = removeRole(String(req.params["userId"]));
  if (!removed) {
    res.status(404).json({ error: "not_found", message: "User has no assigned role" });
    return;
  }
  res.json({ removed: true });
});

export default router;
