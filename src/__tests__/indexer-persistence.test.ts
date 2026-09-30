import { indexer } from "../lib/indexer";
import { pool } from "../lib/db";
import { config } from "../config";

jest.mock("../lib/db", () => ({ pool: { query: jest.fn() } }));
jest.mock("../lib/stellar", () => ({
  withRpcConnection: jest
    .fn()
    .mockImplementation((fn: (client: unknown) => Promise<unknown>) => fn(mockClient)),
}));
jest.mock("../config", () => {
  const actual = jest.requireActual("../config");
  return { ...actual, config: { ...actual.config } };
});

const mockClient = { getLatestLedger: jest.fn(), getEvents: jest.fn(), getTransaction: jest.fn() };
const query = pool.query as jest.Mock;
const cfg = config as unknown as Record<string, unknown>;
const ADDRESS = `G${"A".repeat(55)}`;

const txWith = (type: string, extra: Record<string, unknown> = {}) => ({
  getTransaction: jest.fn().mockResolvedValue({
    source: ADDRESS,
    events: [{ type, amount: 100, shares: 7, ...extra }],
  }),
});

beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
  cfg.VAULT_EVENT_INDEXER_ENABLED = "true";
  cfg.VAULT_EVENT_INDEXER_START_LEDGER = 0;
  (indexer as any).store = { events: [], cursor: 0, lastUpdated: Date.now() };
  (indexer as any).isIndexing = false;
});

describe("event persistence", () => {
  it("upserts with one placeholder per column, in column order", async () => {
    await (indexer as any).processTransaction(txWith("deposit"), "tx1", 42);
    const [sql, params] = query.mock.calls[0];
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(placeholders).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(params).toEqual([42, "tx1", 0, "deposit", ADDRESS, 100, 7, expect.any(Number)]);
    expect(sql).toContain("ON CONFLICT (tx_hash, event_index) DO NOTHING");
  });

  it.each([
    ["WithdrawQueued", "WithdrawQueued"],
    ["withdraw_claimed", "WithdrawClaimed"],
    ["YieldClaimed", "YieldClaimed"],
  ])(
    "classifies %s as %s, persists it, and keeps it out of the in-memory store",
    async (raw, expected) => {
      await (indexer as any).processTransaction(txWith(raw), "tx2", 9);
      expect(query.mock.calls[0][1][3]).toBe(expected);
      expect(indexer.getStore().events).toHaveLength(0);
    },
  );

  it("records a yield claim that carries no shares as 0 shares", async () => {
    const client = {
      getTransaction: jest.fn().mockResolvedValue({
        source: ADDRESS,
        events: [{ type: "YieldClaimed", amount: 55 }],
      }),
    };
    await (indexer as any).processTransaction(client, "tx3", 9);
    expect(query.mock.calls[0][1].slice(5, 7)).toEqual([55, 0]);
  });

  it("does not touch the database when persistence is disabled", async () => {
    cfg.VAULT_EVENT_INDEXER_ENABLED = "false";
    await (indexer as any).processTransaction(txWith("deposit"), "tx4", 1);
    expect(query).not.toHaveBeenCalled();
    expect(indexer.getStore().events).toHaveLength(1);
  });
});

describe("poll() cursor", () => {
  beforeEach(() => {
    mockClient.getLatestLedger.mockResolvedValue({ sequence: 500 });
    mockClient.getEvents.mockResolvedValue({ events: [] });
  });

  it("resumes from the persisted ledger and saves the new one", async () => {
    query.mockResolvedValueOnce({ rows: [{ last_ledger: "300" }] });
    await indexer.poll();
    expect(mockClient.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 300 }),
    );
    const save = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO indexer_cursor"));
    expect(save?.[1]).toEqual(["vault", 500]);
  });

  it("backfills from the configured start ledger when nothing is persisted", async () => {
    cfg.VAULT_EVENT_INDEXER_START_LEDGER = 120;
    await indexer.poll();
    expect(mockClient.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 120 }),
    );
  });
});

describe("getActivity()", () => {
  const row = (n: number) => ({
    ledger: "1",
    tx_hash: `t${n}`,
    event_index: "0",
    type: "deposit",
    address: ADDRESS,
    usdc: "1",
    shares: "1",
    ts: String(1000 - n),
  });

  it("returns a next_cursor that, when passed back, continues after the last row", async () => {
    query.mockResolvedValueOnce({ rows: [row(1), row(2), row(3)] });
    const page = await indexer.getActivity(ADDRESS, null, 2);
    expect(page.events.map((e) => e.tx_hash)).toEqual(["t1", "t2"]);
    expect(page.next_cursor).not.toBeNull();
    expect(query.mock.calls[0][1]).toEqual([ADDRESS, 3]);

    query.mockResolvedValueOnce({ rows: [] });
    await indexer.getActivity(ADDRESS, page.next_cursor, 2);
    const [sql, params] = query.mock.calls[1];
    expect(params).toEqual([ADDRESS, 998, "t2", 0, 3]);
    expect(sql).toContain("(ts, tx_hash, event_index) < ($2, $3, $4)");
    expect(sql).toMatch(/LIMIT \$5\s*$/);
  });

  it("has no next_cursor on the last page", async () => {
    query.mockResolvedValueOnce({ rows: [row(1)] });
    expect((await indexer.getActivity(ADDRESS, null, 2)).next_cursor).toBeNull();
  });

  it("ignores a malformed cursor instead of failing", async () => {
    await indexer.getActivity(ADDRESS, "not-base64-json!", 10);
    expect(query.mock.calls[0][1]).toEqual([ADDRESS, 11]);
  });

  it("rejects with 503 when persistence is disabled", async () => {
    cfg.VAULT_EVENT_INDEXER_ENABLED = "false";
    await expect(indexer.getActivity(ADDRESS, null, 10)).rejects.toMatchObject({ status: 503 });
    await expect(indexer.getPendingWithdrawals(ADDRESS)).rejects.toMatchObject({ status: 503 });
  });
});

describe("getPendingWithdrawals()", () => {
  it("maps rows to numbers and scopes the query to the address", async () => {
    query.mockResolvedValueOnce({
      rows: [{ ledger: "9", tx_hash: "q1", address: ADDRESS, usdc: "12.5", shares: "5", ts: "77" }],
    });
    expect(await indexer.getPendingWithdrawals(` ${ADDRESS} `)).toEqual([
      { ledger: 9, tx_hash: "q1", address: ADDRESS, usdc: 12.5, shares: 5, ts: 77 },
    ]);
    expect(query.mock.calls[0][1]).toEqual([ADDRESS]);
  });
});
