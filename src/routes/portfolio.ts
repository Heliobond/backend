import { Router, Request, Response, NextFunction } from "express";
import { indexer } from "../lib/indexer";
import { badRequest } from "../middleware/errors";

const router = Router();

interface PortfolioEvent {
  id: string;
  type: "deposit" | "withdraw";
  amount: number;
  shares: number;
  timestamp: number;
  txHash: string;
}

interface PortfolioResponse {
  address: string;
  current_shares: number;
  current_value: number;
  events: PortfolioEvent[];
}

router.get("/:address", async (req: Request, res: Response, next: NextFunction) => {
  const address = Array.isArray(req.params.address) ? req.params.address[0] : req.params.address;

  // Stellar account/contract IDs are 56-char strkeys; keep validation lenient
  // but reject obviously malformed input instead of returning empty results.
  if (!address || typeof address !== "string" || address.trim().length < 3) {
    throw badRequest("address must be a non-empty string");
  }

  try {
    const events = indexer.getEventsByAddress(address);

    let totalShares = 0;
    const processedEvents: PortfolioEvent[] = [];

    for (const event of events) {
      if (event.type === "deposit") {
        totalShares += event.shares;
      } else if (event.type === "withdraw") {
        totalShares -= event.shares;
      }

      processedEvents.push({
        id: event.id,
        type: event.type,
        amount: event.amount,
        shares: event.shares,
        timestamp: event.timestamp,
        txHash: event.txHash,
      });
    }

    totalShares = Math.max(0, totalShares);
    const pricePerShare = 1.5 + Math.random() * 0.5;
    const currentValue = totalShares * pricePerShare;

    const response: PortfolioResponse = {
      address,
      current_shares: totalShares,
      current_value: Math.round(currentValue * 100) / 100,
      events: processedEvents.sort((a, b) => b.timestamp - a.timestamp),
    };

    res.json(response);
  } catch (error) {
    console.error("[portfolio] error:", error);
    next(error);
  }
});

export default router;
