import { Router, Request, Response, NextFunction } from "express";
import { badRequest } from "../middleware/errors";
import { walletAuth } from "../middleware/walletAuth";
import {
  getPreferences,
  updatePreferences,
  confirmEmail,
  unsubscribe,
  NotificationEventType,
} from "../lib/notifications";

const router = Router();

// Stellar accounts (G...) and contract ids (C...) are 56-char strbase32.
const ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;
const MAX_PROJECT_IDS = 100;

function requireAddressOwner(req: Request, res: Response, next: NextFunction): void {
  if (req.walletAddress !== req.params.address) {
    res.status(403).json({ error: "forbidden", message: "Wallet signature does not match address" });
    return;
  }
  next();
}

function address(req: Request): string {
  const a = String(req.params.address);
  if (!ADDRESS_RE.test(a)) throw badRequest("address must be a valid Stellar address");
  return a;
}

function queryToken(req: Request): string {
  const t = req.query.token;
  if (typeof t !== "string" || !t) throw badRequest("token query param is required");
  return t;
}

/** GET /v1/notifications/confirm?token= — double opt-in link target (no API key: opened from an email). */
export const publicNotificationsRouter = Router();
publicNotificationsRouter.get("/confirm", (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!confirmEmail(queryToken(req))) {
      res.status(404).json({ error: "not_found", message: "Unknown or already-used confirmation token" });
      return;
    }
    res.json({ confirmed: true });
  } catch (err) {
    next(err);
  }
});

/** GET /v1/notifications/unsubscribe?token= — one-click unsubscribe from any notification email. */
publicNotificationsRouter.get("/unsubscribe", (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!unsubscribe(queryToken(req))) {
      res.status(404).json({ error: "not_found", message: "Unknown unsubscribe token" });
      return;
    }
    res.json({ unsubscribed: true });
  } catch (err) {
    next(err);
  }
});

/** GET /v1/notifications/:address/preferences */
router.get(
  "/:address/preferences",
  walletAuth,
  requireAddressOwner,
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const prefs = getPreferences(address(req));
      if (!prefs) {
        res
          .status(404)
          .json({ error: "not_found", message: "No preferences registered for this address" });
        return;
      }
      res.json(prefs);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PUT /v1/notifications/:address/preferences
 * Body (all optional): { email, webhook_url, events[], score_change_threshold, project_ids[] }
 * Setting a new email sends a confirmation link; nothing is emailed until confirmed.
 * A new webhook_url generates a signing secret, returned once as `webhook_secret`.
 */
router.put(
  "/:address/preferences",
  walletAuth,
  requireAddressOwner,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const addr = address(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (Array.isArray(body.project_ids) && body.project_ids.length > MAX_PROJECT_IDS) {
        throw badRequest(`project_ids cannot contain more than ${MAX_PROJECT_IDS} items`);
      }
      try {
        const result = await updatePreferences(addr, {
          email: body.email as string | null | undefined,
          webhook_url: body.webhook_url as string | null | undefined,
          events: body.events as NotificationEventType[] | undefined,
          score_change_threshold: body.score_change_threshold as number | undefined,
          project_ids: body.project_ids as number[] | undefined,
        });
        res.json(result);
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : "invalid preferences");
      }
    } catch (err) {
      next(err);
    }
  },
);

export default router;
