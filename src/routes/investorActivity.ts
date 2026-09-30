import { Router, Request, Response, NextFunction } from "express";
import { badRequest } from "../middleware/errors";
import { indexer } from "../lib/indexer";

const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 200;

const router = Router();

// GET /:address/activity — per-investor vault activity feed
router.get("/:address/activity", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const address = String(req.params.address).trim();
    if (!address || address.length > 128)
      throw badRequest("address must be a non-empty wallet address");

    const cursorRaw = req.query.cursor;
    if (cursorRaw !== undefined && typeof cursorRaw !== "string") {
      throw badRequest("cursor must be a string");
    }
    const cursor = typeof cursorRaw === "string" && cursorRaw.trim() ? cursorRaw.trim() : null;

    const limitRaw = req.query.limit;
    let limit = DEFAULT_ACTIVITY_LIMIT;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ACTIVITY_LIMIT) {
        throw badRequest(`limit must be an integer between 1 and ${MAX_ACTIVITY_LIMIT}`);
      }
      limit = parsed;
    }

    const page = await indexer.getActivity(address, cursor, limit);
    res.json({
      address,
      events: page.events,
      next_cursor: page.next_cursor,
    });
  } catch (error) {
    next(error);
  }
});

// GET /:address/pending-withdrawals — queued claims not yet claimed
router.get(
  "/:address/pending-withdrawals",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const address = String(req.params.address).trim();
      if (!address || address.length > 128)
        throw badRequest("address must be a non-empty wallet address");

      const pending = await indexer.getPendingWithdrawals(address);
      res.json({ address, pending_withdrawals: pending });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
