import { Router, Request, Response, NextFunction } from "express";
import { StrKey } from "@stellar/stellar-sdk";
import {
  getChains,
  getEnabledChains,
  getChain,
  configureChain,
  broadcastToChains,
  ChainId,
} from "../lib/multichain";
import { badRequest, parseProjectId } from "../middleware/errors";
import { ipWhitelist } from "../middleware/ipWhitelist";
import { requireAdminBearer } from "../middleware/requireAdminBearer";
import { requestSigning } from "../middleware/requestSigning";
import { validatePublicUrl } from "../lib/ssrf";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";

const router = Router();

/**
 * Admin auth stack for mutating routes (#831). Matches sibling admin routers
 * (`/v1/satellite-sources`, `/v1/admin/api-keys`): the request must arrive
 * from a whitelisted IP, carry a valid admin bearer token, and pass HMAC
 * request signing. Previously `/v1/chains` was mounted with only rate
 * limiters, so anyone who could reach the API could change `rpcUrl` /
 * `contractAddress` / `enabled` or trigger admin-signed Soroban submissions.
 */
const adminAuth = [ipWhitelist, requireAdminBearer, requestSigning];

/**
 * GET /v1/chains — list all configured chains.
 * Read endpoints are intentionally public: the chain registry is already
 * surfaced via `/v1/status/oracle` and does not expose secret material.
 */
router.get("/", (_req: Request, res: Response) => {
  res.json({ chains: getChains(), enabled: getEnabledChains().map((c) => c.id) });
});

/** GET /v1/chains/:id — get chain config (public, see note on `GET /`). */
router.get("/:id", (req: Request, res: Response) => {
  const chain = getChain(req.params.id as ChainId);
  if (!chain) return res.status(404).json({ error: "chain not found" });
  res.json(chain);
});

/**
 * PATCH /v1/chains/:id — update chain config (enable/disable, rpcUrl,
 * contractAddress, name). Admin-gated and input-validated.
 *
 * `rpcUrl` goes through `validatePublicUrl` to reject SSRF targets
 * (loopback, link-local, metadata, private ranges). `contractAddress`
 * must be a valid Stellar contract strkey. `name` is bounded by length.
 */
router.patch("/:id", ...adminAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as {
      enabled?: unknown;
      rpcUrl?: unknown;
      contractAddress?: unknown;
      name?: unknown;
    };

    let enabled: boolean | undefined;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }
      enabled = body.enabled;
    }

    let rpcUrl: string | undefined;
    if (body.rpcUrl !== undefined) {
      if (typeof body.rpcUrl !== "string") {
        throw badRequest("rpcUrl must be a string");
      }
      try {
        rpcUrl = await validatePublicUrl(body.rpcUrl);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    }

    let contractAddress: string | undefined;
    if (body.contractAddress !== undefined) {
      if (
        typeof body.contractAddress !== "string" ||
        !StrKey.isValidContract(body.contractAddress)
      ) {
        throw badRequest("contractAddress must be a valid Stellar contract strkey");
      }
      contractAddress = body.contractAddress;
    }

    let name: string | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 200) {
        throw badRequest("name must be a non-empty string of at most 200 characters");
      }
      name = body.name;
    }

    const ok = configureChain(req.params.id as ChainId, {
      enabled,
      rpcUrl,
      contractAddress,
      name,
    });
    if (!ok) return res.status(404).json({ error: "chain not found" });
    res.json({ ok: true, chain: getChain(req.params.id as ChainId) });
  } catch (err) {
    next(err);
  }
});

/***
 * POST /v1/chains/broadcast/:projectId
 * Submit score update to one or more chains. Admin-gated: previously
 * unauthenticated callers could spend the oracle signer's XLM by spamming
 * this route (#831).
 * Body: { chains?: string[] } — defaults to all enabled chains.
 */
router.post(
  "/broadcast/:projectId",
  ...adminAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = parseProjectId(req.params.projectId, "project id");
      const { chains } = req.body as { chains?: string[] };

      // Only Stellar has a real cross-chain submission implemented.
      // EVM chains are not yet supported; return a clear error instead of
      // fabricating a fake transaction hash.
      const targetChains = (chains ?? getEnabledChains().map((c) => c.id)) as ChainId[];
      if (targetChains.some((id) => id !== "stellar")) {
        return res.status(501).json({
          error: "EVM chain submission not implemented; only Stellar is currently supported.",
        });
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
  },
);

export default router;
