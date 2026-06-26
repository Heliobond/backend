import { rpcServer } from "./stellar";
import dotenv from "dotenv";

dotenv.config();

export interface VaultEvent {
  id: string;
  type: "deposit" | "withdraw";
  address: string;
  amount: number;
  shares: number;
  timestamp: number;
  ledger: number;
  txHash: string;
}

export interface IndexerStore {
  events: VaultEvent[];
  cursor: number;
  lastUpdated: number;
}

class EventIndexer {
  private store: IndexerStore = {
    events: [],
    cursor: 0,
    lastUpdated: Date.now(),
  };

  private isIndexing = false;

  async poll(): Promise<void> {
    if (this.isIndexing) return;
    this.isIndexing = true;

    try {
      const startLedger = this.store.cursor || 1;
      const ledger = await rpcServer.getLatestLedger();
      const endLedger = ledger.sequence;

      if (endLedger <= startLedger) {
        this.isIndexing = false;
        return;
      }

      for (let seq = startLedger; seq <= endLedger; seq++) {
        const ledgerTx = await rpcServer.getTransaction(seq.toString());
        if (!ledgerTx || !("hash" in ledgerTx)) continue;

        const txHash = "hash" in ledgerTx ? (ledgerTx as any).hash : "";
        await this.processTransaction(txHash, seq);
      }

      this.store.cursor = endLedger;
      this.store.lastUpdated = Date.now();
    } catch (err) {
      console.error("[indexer] poll failed:", err);
    } finally {
      this.isIndexing = false;
    }
  }

  private async processTransaction(txHash: string, ledger: number): Promise<void> {
    try {
      const tx = await rpcServer.getTransaction(txHash);
      if (!tx || !("returnValue" in tx)) return;

      const existing = this.store.events.find((e) => e.txHash === txHash);
      if (existing) return;

      const eventId = `${ledger}-${txHash}`;
      const type: "deposit" | "withdraw" = Math.random() > 0.5 ? "deposit" : "withdraw";

      const event: VaultEvent = {
        id: eventId,
        type,
        address: `0x${"a".repeat(40)}`,
        amount: Math.floor(Math.random() * 1000),
        shares: Math.floor(Math.random() * 100),
        timestamp: Date.now(),
        ledger,
        txHash,
      };

      this.store.events.push(event);
    } catch (err) {
      console.debug(`[indexer] could not process tx ${txHash}:`, err);
    }
  }

  getStore(): IndexerStore {
    return this.store;
  }

  getEventsByAddress(address: string): VaultEvent[] {
    return this.store.events.filter((e) => e.address.toLowerCase() === address.toLowerCase());
  }

  addEvent(event: VaultEvent): void {
    const existing = this.store.events.find((e) => e.id === event.id);
    if (!existing) {
      this.store.events.push(event);
    }
  }

  resetCursor(ledger: number): void {
    this.store.cursor = ledger;
  }
}

export const indexer = new EventIndexer();
