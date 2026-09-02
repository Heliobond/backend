import { rpc } from "@stellar/stellar-sdk";
import { withRpcConnection } from "./stellar";
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

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function flattenEventCandidates(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) flattenEventCandidates(item, out);
    return out;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.events)) {
      flattenEventCandidates(obj.events, out);
    }

    if (obj.contractEventsXdr !== undefined) {
      flattenEventCandidates(obj.contractEventsXdr, out);
    }

    if (obj.transactionEventsXdr !== undefined) {
      flattenEventCandidates(obj.transactionEventsXdr, out);
    }

    if (obj.data !== undefined && (typeof obj.data === "object" || typeof obj.data === "string")) {
      out.push(obj.data);
    }

    out.push(value);
  }

  return out;
}

function findFirstMatchingValue(
  obj: unknown,
  keys: string[],
  visited = new Set<unknown>(),
): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return undefined;
  if (visited.has(obj)) return undefined;
  visited.add(obj);

  const record = obj as Record<string, unknown>;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
      return record[key];
    }
  }

  for (const value of Object.values(record)) {
    const match = findFirstMatchingValue(value, keys, visited);
    if (match !== undefined) return match;
  }

  return undefined;
}

function extractSourceAccount(tx: any): string | null {
  const candidate = findFirstMatchingValue(tx, ["source", "sourceAccount", "account", "from"]);
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

function parseVaultEvent(
  rawEvent: unknown,
  sourceAccount: string | null,
): Partial<VaultEvent> | null {
  if (!rawEvent || typeof rawEvent !== "object") return null;

  const event = rawEvent as Record<string, unknown>;
  const candidateType =
    findFirstMatchingValue(rawEvent, ["type", "eventType", "kind", "action", "method", "name"]) ??
    (typeof event.value === "string" ? event.value : undefined);

  const normalizedType = typeof candidateType === "string" ? candidateType.toLowerCase() : "";
  const type: "deposit" | "withdraw" | null = normalizedType.includes("deposit")
    ? "deposit"
    : normalizedType.includes("withdraw")
      ? "withdraw"
      : null;

  if (!type) return null;

  const eventAddress =
    typeof findFirstMatchingValue(rawEvent, [
      "address",
      "owner",
      "user",
      "account",
      "accountId",
      "sourceAccount",
    ]) === "string"
      ? String(
          findFirstMatchingValue(rawEvent, [
            "address",
            "owner",
            "user",
            "account",
            "accountId",
            "sourceAccount",
          ]),
        )
      : null;

  const amountValue =
    findFirstMatchingValue(rawEvent, ["amount", "value", "total", "quantity"]) ??
    findFirstMatchingValue(rawEvent, ["amounts", "amount_value"]);
  const sharesValue = findFirstMatchingValue(rawEvent, [
    "shares",
    "shareAmount",
    "share_amount",
    "shareCount",
  ]);

  const address =
    typeof sourceAccount === "string" && sourceAccount.trim()
      ? sourceAccount.trim()
      : typeof eventAddress === "string" && eventAddress.trim()
        ? eventAddress.trim()
        : null;
  const amount = toNumber(amountValue);
  const shares = toNumber(sharesValue);

  if (!address || amount === null || shares === null) {
    return null;
  }

  return {
    type,
    address,
    amount,
    shares,
  };
}

function extractVaultEvent(tx: any): Partial<VaultEvent> | null {
  const sourceAccount = extractSourceAccount(tx);
  const candidates: unknown[] = [];

  flattenEventCandidates(tx, candidates);

  for (const candidate of candidates) {
    const parsed = parseVaultEvent(candidate, sourceAccount);
    if (parsed) {
      return {
        type: parsed.type!,
        address: parsed.address!,
        amount: parsed.amount!,
        shares: parsed.shares!,
      };
    }
  }

  const meta = tx?.resultMetaXdr;
  if (meta && typeof meta === "object") {
    const v1 = (meta as any).v1;
    if (typeof v1 === "function") {
      const result = v1.call(meta);
      if (result && typeof result === "object") {
        const nested = (result as any).events;
        if (Array.isArray(nested)) {
          for (const item of nested) {
            const parsed = parseVaultEvent(item, sourceAccount);
            if (parsed) {
              return {
                type: parsed.type!,
                address: parsed.address!,
                amount: parsed.amount!,
                shares: parsed.shares!,
              };
            }
          }
        }
      }
    }
  }

  if (Array.isArray(tx?.diagnosticEvents)) {
    for (const item of tx.diagnosticEvents) {
      const parsed = parseVaultEvent(item, sourceAccount);
      if (parsed) {
        return {
          type: parsed.type!,
          address: parsed.address!,
          amount: parsed.amount!,
          shares: parsed.shares!,
        };
      }
    }
  }

  return null;
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
      await withRpcConnection(async (client) => {
        const startLedger = this.store.cursor || 1;
        const ledger = await client.getLatestLedger();
        const endLedger = ledger.sequence;

        if (endLedger <= startLedger) return;

        for (let seq = startLedger; seq <= endLedger; seq++) {
          const ledgerTx = await client.getTransaction(seq.toString());
          if (!ledgerTx || !("hash" in ledgerTx)) continue;

          const txHash = "hash" in ledgerTx ? (ledgerTx as any).hash : "";
          await this.processTransaction(client, txHash, seq);
        }

        this.store.cursor = endLedger;
        this.store.lastUpdated = Date.now();
      });
    } catch (err) {
      console.error("[indexer] poll failed:", err);
    } finally {
      this.isIndexing = false;
    }
  }

  private async processTransaction(
    client: rpc.Server,
    txHash: string,
    ledger: number,
  ): Promise<void> {
    try {
      const tx = await client.getTransaction(txHash);
      if (!tx) return;

      const existing = this.store.events.find((e) => e.txHash === txHash);
      if (existing) return;

      const parsed = extractVaultEvent(tx);
      if (!parsed) return;

      const eventId = `${ledger}-${txHash}`;
      const event: VaultEvent = {
        id: eventId,
        type: parsed.type!,
        address: parsed.address!,
        amount: parsed.amount!,
        shares: parsed.shares!,
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
    const normalizedAddress = address.trim();
    return this.store.events.filter((e) => e.address === normalizedAddress);
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
