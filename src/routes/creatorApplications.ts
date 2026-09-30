/**
 * Creator onboarding HTTP surface (#771).
 *
 *  - Creator (wallet-authenticated) routes mounted at `/v1/creators`:
 *      POST /applications                        submit an application
 *      GET  /applications/:id/create-project-tx  unsigned create_project XDR
 *  - Admin (bearer-authenticated) routes mounted at `/v1/admin/creators`:
 *      GET   /applications/:id   fetch one application
 *      PATCH /applications/:id   advance the review workflow
 *
 * Nothing in this layer signs or holds a secret key; XDR builders only receive
 * public addresses. See lib/creatorOnboarding for the pure core.
 */
import { Router, Request, Response, NextFunction } from "express";
import {
  CreatorApplication,
  CreatorApplicationNotFoundError,
  CreatorValidationError,
  buildCreateProjectTx,
  buildSetWhitelistTx,
  getApplication,
  listApplications,
  reviewApplication,
  submitApplication,
  CreatorApplicationStatus,
} from "../lib/creatorOnboarding";
import { ApiError, badRequest } from "../middleware/errors";
import { walletAuth } from "../middleware/walletAuth";
import { requireAdminBearer } from "../middleware/requireAdminBearer";
import { writeAuditLog } from "../lib/audit-logger";
import { getCorrelationId } from "../lib/correlation";
import { notify } from "../lib/notifications";
import { logger } from "../lib/logger";
import { config } from "../config";

const REVIEW_STATUSES: readonly string[] = ["in_review", "approved", "rejected"];
type ReviewStatus = Extract<CreatorApplicationStatus, "in_review" | "approved" | "rejected">;

function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && REVIEW_STATUSES.includes(value);
}

function fail(next: NextFunction, err: unknown): void {
  if (err instanceof CreatorValidationError) {
    next(badRequest(err.message));
    return;
  }
  if (err instanceof CreatorApplicationNotFoundError) {
    next(new ApiError(404, "not_found", err.message));
    return;
  }
  next(err);
}

function auditApplication(
  req: Request,
  action: string,
  application: CreatorApplication,
  success: boolean,
  extra: Record<string, unknown> = {},
): void {
  writeAuditLog({
    action,
    correlation_id: getCorrelationId(),
    ip: req.ip ?? null,
    user_agent: req.get("user-agent") ?? null,
    project_ids: application.project_id !== null ? [application.project_id] : [],
    success,
    results: { application_id: application.id, status: application.status, ...extra },
  });
}

/** Notify the wallet owner of a state change; delivery failures are isolated. */
async function notifyStatus(application: CreatorApplication): Promise<void> {
  try {
    await notify({
      type: "creator_application_status",
      id: `${application.id}:${application.status}`,
      address: application.wallet,
      project_id: application.project_id ?? undefined,
      data: {
        application_id: application.id,
        status: application.status,
        metadata_hash: application.metadata_hash,
        project_id: application.project_id,
      },
    });
  } catch (err) {
    logger.error("[creator-onboarding] notification failed", logger.formatError(err));
  }
}

// ── Creator routes ───────────────────────────────────────────────────────────

export const creatorApplicationsRouter = Router();
creatorApplicationsRouter.use(walletAuth);

/** POST /v1/creators/applications — submit project metadata for review. */
creatorApplicationsRouter.post(
  "/applications",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const wallet = req.walletAddress;
      if (!wallet) throw new ApiError(401, "unauthorized", "Wallet authentication required");
      const application = submitApplication(wallet, req.body ?? {});
      auditApplication(req, "creator.application.submitted", application, true);
      void notifyStatus(application);
      res.status(201).json(application);
    } catch (err) {
      fail(next, err);
    }
  },
);

/**
 * GET /v1/creators/applications/:id/create-project-tx — unsigned
 * `create_project` XDR for the creator's wallet to sign and submit.
 */
creatorApplicationsRouter.get(
  "/applications/:id/create-project-tx",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const application = getApplication(String(req.params.id));
      if (!application) throw new CreatorApplicationNotFoundError(String(req.params.id));
      if (application.wallet !== req.walletAddress) {
        throw new ApiError(403, "forbidden", "This application belongs to another wallet");
      }
      if (
        application.status !== "approved" ||
        !application.metadata_hash ||
        !application.metadata_uri
      ) {
        throw new ApiError(
          409,
          "conflict",
          "Application must be approved (and metadata pinned) before a project transaction can be built",
        );
      }
      const contractId = config.PROJECT_REGISTRY_CONTRACT_ID;
      if (!contractId) {
        throw new ApiError(
          503,
          "service_unavailable",
          "Project registry contract is not configured",
        );
      }

      const sequence = String(req.query.sequence ?? "0");
      if (!/^\d+$/.test(sequence))
        throw badRequest("sequence must be a non-negative integer string");
      const maturityRaw = String(req.query.maturity_date ?? "0");
      if (!/^\d+$/.test(maturityRaw)) {
        throw badRequest("maturity_date must be a non-negative integer (unix seconds)");
      }
      const maturityDate = Number(maturityRaw);

      const xdr = buildCreateProjectTx({
        contractId,
        sourceAccount: application.wallet,
        sequence,
        creator: application.wallet,
        uri: application.metadata_uri,
        maturityDate,
        metadataHash: application.metadata_hash,
      });

      res.json({
        application_id: application.id,
        project_id: application.project_id,
        metadata_hash: application.metadata_hash,
        metadata_uri: application.metadata_uri,
        maturity_date: maturityDate,
        unsigned_xdr: xdr,
        signed: false,
      });
    } catch (err) {
      fail(next, err);
    }
  },
);

// ── Admin routes ─────────────────────────────────────────────────────────────

export const creatorAdminRouter = Router();
creatorAdminRouter.use(requireAdminBearer);

function applicationId(req: Request): string {
  const id = String(req.params.id ?? "").trim();
  if (!id) throw badRequest("application id is required");
  return id;
}

/** GET /v1/admin/creators/applications — list applications. */
creatorAdminRouter.get("/applications", (_req: Request, res: Response) => {
  res.json({ applications: listApplications() });
});

/** GET /v1/admin/creators/applications/:id — fetch one application. */
creatorAdminRouter.get("/applications/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const application = getApplication(applicationId(req));
    if (!application) throw new CreatorApplicationNotFoundError(applicationId(req));
    res.json(application);
  } catch (err) {
    fail(next, err);
  }
});

/**
 * PATCH /v1/admin/creators/applications/:id — advance the review workflow.
 * Body: `{ status, actor?, note?, whitelister?, whitelister_sequence? }`.
 * On `approved` the response includes the unsigned `set_whitelist_tx` when a
 * `whitelister` public address is supplied.
 */
creatorAdminRouter.patch(
  "/applications/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = applicationId(req);
      const body = req.body ?? {};
      if (!isReviewStatus(body.status)) {
        throw badRequest(`status must be one of: ${REVIEW_STATUSES.join(", ")}`);
      }
      const actor =
        typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "admin";
      const note = typeof body.note === "string" ? body.note : undefined;

      const existing = getApplication(id);
      if (!existing) throw new CreatorApplicationNotFoundError(id);

      // Build (and validate) the whitelist transaction *before* mutating the
      // application so an invalid whitelister cannot leave it approved.
      let setWhitelistTx: string | undefined;
      if (body.status === "approved" && typeof body.whitelister === "string" && body.whitelister) {
        const sequence =
          typeof body.whitelister_sequence === "string" ? body.whitelister_sequence : "0";
        if (!/^\d+$/.test(sequence)) {
          throw badRequest("whitelister_sequence must be a non-negative integer string");
        }
        const contractId = config.PROJECT_REGISTRY_CONTRACT_ID;
        if (!contractId) {
          throw new ApiError(
            503,
            "service_unavailable",
            "Project registry contract is not configured",
          );
        }
        setWhitelistTx = buildSetWhitelistTx({
          contractId,
          sourceAccount: body.whitelister,
          sequence,
          account: existing.wallet,
        });
      }

      const application = await reviewApplication(id, body.status, actor, note);

      auditApplication(req, "creator.application.reviewed", application, true, {
        transition: body.status,
        actor,
      });
      await notifyStatus(application);

      res.json(setWhitelistTx ? { ...application, set_whitelist_tx: setWhitelistTx } : application);
    } catch (err) {
      fail(next, err);
    }
  },
);
