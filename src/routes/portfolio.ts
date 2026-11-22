import { Router, Request, Response, NextFunction } from "express";
import { indexer, VaultEvent } from "../lib/indexer";
import { logger } from "../lib/logger";
import { badRequest } from "../middleware/errors";
import { getPortfolio, validateStellarAddress, i128ToDecimal } from "../lib/vault";

const router = Router();

interface PortfolioEvent {
  id: string;
  type: VaultEvent["type"];
  amount: number;
  shares: number;
  timestamp: number;
  txHash: string;
}

interface PortfolioResponse {
  address: string;
  shares: string;
  shares_display: string;
  usdc_value: string;
  usdc_value_display: string;
  claimable_yield: string;
  claimable_yield_display: string;
  share_of_pool_bps: number;
  total_deposited: string;
  total_deposited_display: string;
  events: PortfolioEvent[];
  next_cursor?: string | null;
}

router.get("/:address", async (req: Request, res: Response, next: NextFunction) => {
  const address = Array.isArray(req.params.address) ? req.params.address[0] : req.params.address;

  try {
    // Validate the address as a G- or C-strkey
    validateStellarAddress(address);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : String(err));
  }

  const cursorRaw = req.query.cursor;
  if (cursorRaw !== undefined && typeof cursorRaw !== "string") {
    throw badRequest("cursor must be a string");
  }
  const cursor = typeof cursorRaw === "string" && cursorRaw.trim() ? cursorRaw.trim() : null;

  const limitRaw = req.query.limit;
  let limit = 20;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      throw badRequest("limit must be an integer between 1 and 200");
    }
    limit = parsed;
  }

  try {
    // Fetch portfolio data from the vault contract
    const portfolio = await getPortfolio(address);

    // Fetch historical events from the indexer
    const events = indexer.getEventsByAddress(address);
    const sorted = events.slice().sort((a, b) => b.timestamp - a.timestamp);
    let startIndex = 0;
    if (cursor) {
      const foundIdx = sorted.findIndex((e) => e.id === cursor || e.txHash === cursor);
      if (foundIdx >= 0) {
        startIndex = foundIdx + 1;
      }
    }
    const paged = sorted.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + paged.length < sorted.length;
    const nextCursor = hasMore && paged.length > 0 ? paged[paged.length - 1].id : null;

    const processedEvents: PortfolioEvent[] = paged.map((event) => ({
      id: event.id,
      type: event.type,
      amount: event.amount,
      shares: event.shares,
      timestamp: event.timestamp,
      txHash: event.txHash,
    }));

    const response: PortfolioResponse = {
      address,
      shares: portfolio.shares,
      shares_display: i128ToDecimal(portfolio.shares, 7),
      usdc_value: portfolio.usdc_value,
      usdc_value_display: i128ToDecimal(portfolio.usdc_value, 7),
      claimable_yield: portfolio.claimable_yield,
      claimable_yield_display: i128ToDecimal(portfolio.claimable_yield, 7),
      share_of_pool_bps: portfolio.share_of_pool_bps,
      total_deposited: portfolio.total_deposited,
      total_deposited_display: i128ToDecimal(portfolio.total_deposited, 7),
      events: processedEvents,
      next_cursor: nextCursor,
    };

    res.json(response);
  } catch (error) {
    logger.error("[portfolio] error", logger.formatError(error));
    next(error);
  }
});

export default router;
