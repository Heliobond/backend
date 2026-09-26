import { Router, Request, Response, NextFunction } from "express";
import { indexer } from "../lib/indexer";
import { badRequest } from "../middleware/errors";
import { seededRandom } from "../lib/iot";

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

/**
 * Deterministic 32-bit string hash (FNV-1a). Portfolio pricing is seeded from
 * the address so the simulated value is stable per (address, clock hour),
 * mirroring how IoT readings are keyed on project id.
 */
function hashAddress(address: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < address.length; i++) {
    h ^= address.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
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
    // Hour-seeded like every other simulated reading (see seededRandom in
    // lib/iot), so current_value is stable across requests within an hour
    // instead of jumping randomly on every call.
    const pricePerShare = 1.5 + seededRandom(hashAddress(address)) * 0.5;
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
