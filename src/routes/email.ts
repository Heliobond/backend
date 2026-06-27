import { Router, Request, Response, NextFunction } from "express";
import {
  subscribe,
  unsubscribeByToken,
  listSubscribers,
  getThresholds,
  setThresholds,
  listTemplates,
  upsertTemplate,
  sendDigest,
  Frequency,
} from "../lib/email";
import { badRequest } from "../middleware/errors";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** POST /email/subscribe — { email, frequency? } */
router.post("/subscribe", (req: Request, res: Response) => {
  const { email, frequency } = req.body as { email?: unknown; frequency?: unknown };
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    throw badRequest("email must be a valid email address");
  }
  if (frequency !== undefined && frequency !== "daily" && frequency !== "weekly") {
    throw badRequest("frequency must be 'daily' or 'weekly'");
  }
  const sub = subscribe(email, (frequency as Frequency) ?? "weekly");
  res.status(201).json({
    email: sub.email,
    frequency: sub.frequency,
    unsubscribe_token: sub.unsubscribe_token,
    subscribed_at: sub.subscribed_at,
  });
});

/** GET /email/unsubscribe?token= — one-click unsubscribe. */
router.get("/unsubscribe", (req: Request, res: Response) => {
  const token = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
  if (typeof token !== "string" || !token) {
    throw badRequest("token query param is required");
  }
  const removed = unsubscribeByToken(token);
  if (!removed) {
    res.status(404).json({ error: "not_found", message: "Unknown or already-used unsubscribe token" });
    return;
  }
  res.json({ unsubscribed: true });
});

/** GET /email/subscribers — list current subscribers. */
router.get("/subscribers", (req: Request, res: Response) => {
  const frequency =
    req.query.frequency === "daily" || req.query.frequency === "weekly"
      ? (req.query.frequency as Frequency)
      : undefined;
  res.json({ subscribers: listSubscribers(frequency) });
});

/** GET /email/thresholds — current alert thresholds. */
router.get("/thresholds", (_req: Request, res: Response) => {
  res.json(getThresholds());
});

/** PUT /email/thresholds — update alert thresholds. */
router.put("/thresholds", (req: Request, res: Response) => {
  try {
    res.json(setThresholds(req.body ?? {}));
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "invalid thresholds");
  }
});

/** GET /email/templates — list templates. */
router.get("/templates", (_req: Request, res: Response) => {
  res.json({ templates: listTemplates() });
});

/** PUT /email/templates — create or update a template. */
router.put("/templates", (req: Request, res: Response) => {
  const { name, subject, body } = req.body as { name?: unknown; subject?: unknown; body?: unknown };
  if (typeof name !== "string" || typeof subject !== "string" || typeof body !== "string") {
    throw badRequest("template requires string name, subject and body");
  }
  res.json(upsertTemplate({ name, subject, body }));
});

/** POST /email/digest — trigger a digest send. Body: { frequency, changes? } */
router.post("/digest", async (req: Request, res: Response, next: NextFunction) => {
  const { frequency, changes } = req.body as { frequency?: unknown; changes?: unknown };
  if (frequency !== "daily" && frequency !== "weekly") {
    throw badRequest("frequency must be 'daily' or 'weekly'");
  }
  try {
    const sent = await sendDigest(frequency, Array.isArray(changes) ? changes : []);
    res.json({ frequency, sent });
  } catch (error) {
    console.error("[email] digest error:", error);
    next(error);
  }
});

export default router;
