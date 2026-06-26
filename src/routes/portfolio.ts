import { Router, Request, Response } from "express";
import { indexer } from "../lib/indexer";

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

router.get("/:address", async (req: Request, res: Response) => {
  try {
    const address = req.params.address;

    if (!address || typeof address !== "string") {
      return res.status(400).json({ error: "invalid address" });
    }

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
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
