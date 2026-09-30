import { rpc } from "@stellar/stellar-sdk";
import { withRpcConnection } from "./stellar";
import { logger } from "./logger";
import { pool } from "./db";
import { config } from "../config";
import { ApiError } from "../middleware/errors";
import { linkProjectToApplication } from "./creatorOnboarding";

export type VaultEventType =
  "deposit" | "withdraw" | "WithdrawQueued" | "WithdrawClaimed" | "YieldClaimed";

export interface VaultEvent {
  id: string;
  type: VaultEventType;
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

function classifyEventType(name: string): VaultEventType | null {
  const n = name.replace(/[^a-z]/g, "");
  if (n.includes("yield") && n.includes("claim")) return "YieldClaimed";
  if (n.includes("withdraw") && n.includes("queue")) return "WithdrawQueued";
  if (n.includes("withdraw") && n.includes("claim")) return "WithdrawClaimed";
  if (n.includes("deposit")) return "deposit";
  if (n.includes("withdraw")) return "withdraw";
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
  const type = classifyEventType(normalizedType);
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
  const shares = toNumber(sharesValue) ?? (type === "YieldClaimed" ? 0 : null);

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

interface IndexedProjectCreated {
  projectId: number;
  metadataHash: string;
}

/**
 * Extract a `ProjectCreated` contract event (#771) emitted by `create_project`.
 * Linking is by `metadata_hash`, which uniquely identifies the approved
 * application whose metadata was pinned. Returns null for non-matching txs.
 */
function extractProjectCreatedEvent(tx: unknown): IndexedProjectCreated | null {
  const candidates: unknown[] = [];
  flattenEventCandidates(tx, candidates);

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = findFirstMatchingValue(candidate, [
      "type",
      "eventType",
      "kind",
      "action",
      "method",
      "name",
    ]);
    const normalized = typeof name === "string" ? name.replace(/[^a-z]/gi, "").toLowerCase() : "";
    if (!normalized.includes("projectcreated")) continue;

    const projectId = toNumber(
      findFirstMatchingValue(candidate, ["project_id", "projectId", "created_project_id"]),
    );
    const hashValue = findFirstMatchingValue(candidate, [
      "metadata_hash",
      "metadataHash",
      "meta_hash",
    ]);
    const metadataHash = typeof hashValue === "string" ? hashValue : null;
    if (projectId === null || !metadataHash) continue;
    return { projectId, metadataHash };
  }
  return null;
}

/** Persisted event row from the vault_events table. */
export interface PersistedVaultEvent {
  ledger: number;
  tx_hash: string;
  event_index: number;
  type: string;
  address: string;
  usdc: number;
  shares: number;
  ts: number;
}

export interface ActivityPage {
  events: PersistedVaultEvent[];
  next_cursor: string | null;
}

export interface PendingWithdrawal {
  ledger: number;
  tx_hash: string;
  address: string;
  usdc: number;
  shares: number;
  ts: number;
}

const CURSOR_ID = "vault";

function decodeCursor(
  cursor: string | null,
): { ts: number; txHash: string; eventIndex: number } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (
      typeof parsed.ts === "number" &&
      typeof parsed.txHash === "string" &&
      typeof parsed.eventIndex === "number"
    ) {
      return { ts: parsed.ts, txHash: parsed.txHash, eventIndex: parsed.eventIndex };
    }
  } catch {
    return null;
  }
  return null;
}

function encodeCursor(event: PersistedVaultEvent): string {
  return Buffer.from(
    JSON.stringify({ ts: event.ts, txHash: event.tx_hash, eventIndex: event.event_index }),
  ).toString("base64");
}

export class EventIndexer {
  private store: IndexerStore = {
    events: [],
    cursor: 0,
    lastUpdated: Date.now(),
  };

  private isIndexing = false;

  /** Persistence needs a configured database, so it is opt-in. */
  private get persistenceEnabled(): boolean {
    return config.VAULT_EVENT_INDEXER_ENABLED === "true";
  }

  private requirePersistence(): void {
    if (!this.persistenceEnabled) {
      throw new ApiError(
        503,
        "indexer_disabled",
        "Vault event persistence is disabled (set VAULT_EVENT_INDEXER_ENABLED=true)",
      );
    }
  }

  /** Read the last processed ledger from the DB. */
  private async loadCursor(): Promise<number> {
    const res = await pool.query("SELECT last_ledger FROM indexer_cursor WHERE name = $1", [
      CURSOR_ID,
    ]);
    if (res.rows.length === 0) return 0;
    return Number(res.rows[0].last_ledger);
  }

  /** Persist the last processed ledger. */
  private async saveCursor(ledger: number): Promise<void> {
    await pool.query(
      `INSERT INTO indexer_cursor (name, last_ledger) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET last_ledger = EXCLUDED.last_ledger, updated_at = now()`,
      [CURSOR_ID, ledger],
    );
  }

  /** Idempotent upsert of a single indexed event. */
  private async upsertEvent(event: PersistedVaultEvent): Promise<void> {
    await pool.query(
      `INSERT INTO vault_events (ledger, tx_hash, event_index, type, address, usdc, shares, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tx_hash, event_index) DO NOTHING`,
      [
        event.ledger,
        event.tx_hash,
        event.event_index,
        event.type,
        event.address,
        event.usdc,
        event.shares,
        event.ts,
      ],
    );
  }

  async poll(): Promise<void> {
    if (this.isIndexing) return;
    this.isIndexing = true;

    try {
      if (this.persistenceEnabled) {
        const persistedCursor = await this.loadCursor();
        if (persistedCursor > 0) this.store.cursor = persistedCursor;
      }

      await withRpcConnection(async (client) => {
        // First run: backfill from the configured start ledger.
        const startLedger =
          this.store.cursor || Math.max(config.VAULT_EVENT_INDEXER_START_LEDGER, 1);
        const ledger = await client.getLatestLedger();
        const endLedger = ledger.sequence;

        if (endLedger <= startLedger) return;

        // Use getEvents() to enumerate real contract events in the ledger range.
        // getTransaction() requires a 64-char hex transaction hash — passing a
        // ledger sequence number (e.g. "12345678") is not a valid hash and will
        // never match a real transaction, so the old loop silently discovered
        // nothing. getEvents() is the correct RPC surface for this use-case.
        const eventsResponse = await (client as any).getEvents({
          startLedger,
          filters: [{ type: "contract" }],
        });

        const rawEvents: unknown[] = Array.isArray(eventsResponse?.events)
          ? eventsResponse.events
          : [];

        // Collect unique (txHash, ledger) pairs so we call processTransaction
        // once per transaction, not once per event inside that transaction.
        const seen = new Map<string, number>();
        for (const event of rawEvents) {
          const e = event as Record<string, unknown>;
          const txHash =
            typeof e.txHash === "string" && e.txHash.trim()
              ? e.txHash.trim()
              : typeof e.transactionHash === "string" && e.transactionHash.trim()
                ? e.transactionHash.trim()
                : null;
          const eventLedger =
            typeof e.ledger === "number"
              ? e.ledger
              : typeof e.ledgerSequence === "number"
                ? e.ledgerSequence
                : null;

          if (txHash && eventLedger !== null && !seen.has(txHash)) {
            seen.set(txHash, eventLedger);
          }
        }

        for (const [txHash, txLedger] of seen) {
          await this.processTransaction(client, txHash, txLedger);
        }

        this.store.cursor = endLedger;
        this.store.lastUpdated = Date.now();
        if (this.persistenceEnabled) await this.saveCursor(endLedger);
      });
    } catch (err) {
      logger.error("[indexer] poll failed", logger.formatError(err));
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

      // Creator-onboarding: a confirmed create_project links the on-chain
      // project id back to the approved application (#771).
      const projectCreated = extractProjectCreatedEvent(tx);
      if (projectCreated) {
        try {
          const linked = linkProjectToApplication({
            metadataHash: projectCreated.metadataHash,
            projectId: projectCreated.projectId,
            txHash,
            ledger,
          });
          if (linked) {
            logger.info(
              `[indexer] linked ProjectCreated ${projectCreated.projectId} to application ${linked.id}`,
            );
          }
        } catch (err) {
          logger.debug("[indexer] project link failed", logger.formatError(err));
        }
      }

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

      // Persist idempotently on (tx_hash, event_index).
      if (this.persistenceEnabled) {
        await this.upsertEvent({
          ledger,
          tx_hash: txHash,
          event_index: 0,
          type: event.type,
          address: event.address,
          usdc: event.amount,
          shares: event.shares,
          ts: event.timestamp,
        });
      }

      // The in-memory store only tracks position-changing events; queue, claim
      // and yield events are persisted for the activity feed but kept out of it.
      const existing = this.store.events.find((e) => e.txHash === txHash);
      if (!existing && (event.type === "deposit" || event.type === "withdraw")) {
        this.store.events.push(event);
      }
    } catch (err) {
      logger.debug(`[indexer] could not process tx ${txHash}`, logger.formatError(err));
    }
  }

  /** Paginated activity for an investor, ordered by ts DESC. */
  async getActivity(address: string, cursor: string | null, limit: number): Promise<ActivityPage> {
    this.requirePersistence();
    const normalized = address.trim();
    const decoded = decodeCursor(cursor);
    const params: unknown[] = [normalized];
    let where = "address = $1";
    if (decoded) {
      params.push(decoded.ts, decoded.txHash, decoded.eventIndex);
      where += ` AND (ts, tx_hash, event_index) < ($2, $3, $4)`;
    }
    params.push(limit + 1);
    const res = await pool.query(
      `SELECT ledger, tx_hash, event_index, type, address, usdc, shares, ts
       FROM vault_events WHERE ${where}
       ORDER BY ts DESC, tx_hash DESC, event_index DESC
       LIMIT $${params.length}`,
      params,
    );
    const rows = res.rows.map((r: Record<string, unknown>) => ({
      ledger: Number(r.ledger),
      tx_hash: String(r.tx_hash),
      event_index: Number(r.event_index),
      type: String(r.type),
      address: String(r.address),
      usdc: Number(r.usdc),
      shares: Number(r.shares),
      ts: Number(r.ts),
    }));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;
    return { events: page, next_cursor: nextCursor };
  }

  /**
   * Queued withdrawals not yet claimed. The vault gives a queue and its claim
   * no shared id, so they are paired first-in-first-out per (address, shares):
   * each WithdrawClaimed settles the oldest matching WithdrawQueued.
   */
  async getPendingWithdrawals(address: string): Promise<PendingWithdrawal[]> {
    this.requirePersistence();
    const res = await pool.query(
      `WITH queued AS (
         SELECT ledger, tx_hash, address, usdc, shares, ts,
                ROW_NUMBER() OVER (PARTITION BY shares ORDER BY ts DESC, tx_hash DESC) AS rn,
                COUNT(*) OVER (PARTITION BY shares) AS total
         FROM vault_events WHERE address = $1 AND type = 'WithdrawQueued'
       ), claimed AS (
         SELECT shares, COUNT(*) AS n
         FROM vault_events WHERE address = $1 AND type = 'WithdrawClaimed'
         GROUP BY shares
       )
       SELECT q.ledger, q.tx_hash, q.address, q.usdc, q.shares, q.ts
       FROM queued q LEFT JOIN claimed c ON c.shares = q.shares
       WHERE q.rn <= q.total - COALESCE(c.n, 0)
       ORDER BY q.ts DESC, q.tx_hash DESC`,
      [address.trim()],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      ledger: Number(r.ledger),
      tx_hash: String(r.tx_hash),
      address: String(r.address),
      usdc: Number(r.usdc),
      shares: Number(r.shares),
      ts: Number(r.ts),
    }));
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
