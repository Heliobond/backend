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
}

router.get("/:address", async (req: Request, res: Response, next: NextFunction) => {
  const address = Array.isArray(req.params.address) ? req.params.address[0] : req.params.address;

  try {
    // Validate the address as a G- or C-strkey
    validateStellarAddress(address);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : String(err));
  }

  try {
    // Fetch portfolio data from the vault contract
    const portfolio = await getPortfolio(address);

    // Fetch historical events from the indexer
    const events = indexer.getEventsByAddress(address);

    const processedEvents: PortfolioEvent[] = events.map((event) => ({
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
      events: processedEvents.sort((a, b) => b.timestamp - a.timestamp),
    };

    res.json(response);
  } catch (error) {
    logger.error("[portfolio] error", logger.formatError(error));
    next(error);
  }
});

export default router;
