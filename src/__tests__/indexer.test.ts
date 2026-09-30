import { indexer, VaultEvent } from "../lib/indexer";
import { config } from "../config";

// Prevent withRpcConnection from touching the real Stellar network; we supply
// a mock client directly through the callback.
jest.mock("../lib/stellar", () => ({
  withRpcConnection: jest
    .fn()
    .mockImplementation((fn: (client: unknown) => Promise<unknown>) => fn(mockClient)),
}));

// Defined at module scope so individual tests can reconfigure per-call behaviour.
const mockClient = {
  getLatestLedger: jest.fn(),
  getEvents: jest.fn(),
  getTransaction: jest.fn(),
};

const resetStore = () => {
  (indexer as any).store = { events: [], cursor: 0, lastUpdated: Date.now() };
  (indexer as any).isIndexing = false;
};

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
});

// ---------------------------------------------------------------------------
// poll() — correct RPC surface
// ---------------------------------------------------------------------------

describe("EventIndexer.poll()", () => {
  it("calls getEvents() to discover transactions, NOT getTransaction(seq) for every ledger", async () => {
    // Arrange: ledger range 1 → 5, one contract event with a real tx hash.
    const TX_HASH = "a".repeat(64);
    mockClient.getLatestLedger.mockResolvedValue({ sequence: 5 });
    mockClient.getEvents.mockResolvedValue({
      events: [{ txHash: TX_HASH, ledger: 3, type: "contract" }],
    });
    // processTransaction calls getTransaction with the real hash to fetch details.
    mockClient.getTransaction.mockResolvedValue({
      source: `G${"A".repeat(55)}`,
      events: [{ type: "deposit", amount: 500, shares: 10 }],
    });

    await indexer.poll();

    // getEvents must have been invoked with the ledger range — this is the
    // correct way to enumerate events across ledgers.
    expect(mockClient.getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 1 }));

    // getTransaction must have been called with the real 64-char hash, never
    // with a plain ledger sequence number like "1", "2", "3", etc.
    const transactionCalls: string[] = mockClient.getTransaction.mock.calls.map(
      ([arg]: [string]) => arg,
    );
    for (const arg of transactionCalls) {
      expect(arg).toBe(TX_HASH); // must be a hash, not "1"/"2"/"3"/"4"/"5"
      expect(/^\d+$/.test(arg)).toBe(false); // must NOT be a bare integer string
    }
  });

  it("advances the cursor to endLedger after a successful poll", async () => {
    mockClient.getLatestLedger.mockResolvedValue({ sequence: 10 });
    mockClient.getEvents.mockResolvedValue({ events: [] });

    await indexer.poll();

    expect(indexer.getStore().cursor).toBe(10);
  });

  it("does not advance cursor or call getEvents when endLedger <= startLedger", async () => {
    (indexer as any).store.cursor = 10;
    mockClient.getLatestLedger.mockResolvedValue({ sequence: 10 });

    await indexer.poll();

    expect(mockClient.getEvents).not.toHaveBeenCalled();
    expect(indexer.getStore().cursor).toBe(10);
  });

  it("deduplicates events sharing the same txHash so processTransaction runs once per tx", async () => {
    const TX_HASH = "b".repeat(64);
    mockClient.getLatestLedger.mockResolvedValue({ sequence: 5 });
    // Two events in the same transaction — should only trigger one processTransaction call.
    mockClient.getEvents.mockResolvedValue({
      events: [
        { txHash: TX_HASH, ledger: 3 },
        { txHash: TX_HASH, ledger: 3 },
      ],
    });
    mockClient.getTransaction.mockResolvedValue(null);

    await indexer.poll();

    expect(mockClient.getTransaction).toHaveBeenCalledTimes(1);
    expect(mockClient.getTransaction).toHaveBeenCalledWith(TX_HASH);
  });

  it("handles a getEvents response with no events without throwing", async () => {
    mockClient.getLatestLedger.mockResolvedValue({ sequence: 3 });
    mockClient.getEvents.mockResolvedValue({ events: [] });

    await expect(indexer.poll()).resolves.not.toThrow();
    expect(indexer.getStore().cursor).toBe(3);
  });

  it("skips events that carry no recognisable txHash", async () => {
    mockClient.getLatestLedger.mockResolvedValue({ sequence: 5 });
    mockClient.getEvents.mockResolvedValue({
      events: [{ ledger: 3 /* no txHash field */ }],
    });

    await indexer.poll();

    expect(mockClient.getTransaction).not.toHaveBeenCalled();
  });

  it("ingests a deposit event discovered through poll() end-to-end", async () => {
    const TX_HASH = "c".repeat(64);
    const SOURCE = `G${"B".repeat(55)}`;
    mockClient.getLatestLedger.mockResolvedValue({ sequence: 7 });
    mockClient.getEvents.mockResolvedValue({
      events: [{ txHash: TX_HASH, ledger: 5 }],
    });
    mockClient.getTransaction.mockResolvedValue({
      source: SOURCE,
      events: [{ type: "deposit", amount: 1000, shares: 50 }],
    });

    await indexer.poll();

    const stored = indexer.getStore().events;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      type: "deposit",
      address: SOURCE,
      amount: 1000,
      shares: 50,
      txHash: TX_HASH,
      ledger: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// processTransaction() — unchanged behaviour
// ---------------------------------------------------------------------------

describe("EventIndexer.processTransaction()", () => {
  it("indexes real transaction fields instead of fabricating them", async () => {
    const sourceAccount = `G${"A".repeat(55)}`;
    const txHash = "txhash-123";

    const client = {
      getTransaction: jest.fn().mockResolvedValue({
        txHash,
        source: sourceAccount,
        events: {
          contractEventsXdr: [
            {
              type: "deposit",
              address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              amount: 1250,
              shares: 42,
            },
          ],
        },
        resultMetaXdr: {
          v1: () => ({
            events: [{ type: "deposit", address: "0x1111", amount: 1250, shares: 42 }],
          }),
        },
        diagnosticEvents: [{ type: "deposit", address: "0x2222", amount: 1250, shares: 42 }],
      }),
    };

    await (indexer as any).processTransaction(client as any, txHash, 42);

    expect(indexer.getStore().events).toHaveLength(1);
    expect(indexer.getStore().events[0]).toMatchObject({
      id: "42-txhash-123",
      type: "deposit",
      address: sourceAccount,
      amount: 1250,
      shares: 42,
      txHash,
      ledger: 42,
    });
  });
});

// ---------------------------------------------------------------------------
// Bounded event store — eviction (#676)
// ---------------------------------------------------------------------------

describe("EventIndexer event store eviction", () => {
  const setMaxEvents = (max: number) => {
    (
      config as unknown as { VAULT_EVENT_INDEXER_MAX_EVENTS: number }
    ).VAULT_EVENT_INDEXER_MAX_EVENTS = max;
  };

  const makeEvent = (id: string, overrides: Partial<VaultEvent> = {}): VaultEvent => ({
    id,
    type: "deposit",
    address: `G${"C".repeat(55)}`,
    amount: 1,
    shares: 1,
    timestamp: Date.now(),
    ledger: 1,
    txHash: id,
    ...overrides,
  });

  afterEach(() => {
    setMaxEvents(1000);
  });

  it("caps the store at the configured max, keeping the newest and dropping the oldest", () => {
    const cap = 3;
    setMaxEvents(cap);

    for (let i = 0; i < cap + 2; i++) {
      indexer.addEvent(makeEvent(`evt-${i}`, { txHash: `tx-${i}` }));
    }

    const ids = indexer.getStore().events.map((e) => e.id);
    expect(ids).toHaveLength(cap);
    expect(ids).toEqual(["evt-2", "evt-3", "evt-4"]);
  });

  it("does not double-store a duplicate id within the retained window", () => {
    setMaxEvents(10);
    const event = makeEvent("evt-1", { txHash: "tx-1" });

    indexer.addEvent(event);
    indexer.addEvent({ ...event });

    expect(indexer.getStore().events).toHaveLength(1);
  });

  it("does not double-store events sharing a txHash within the retained window", async () => {
    setMaxEvents(10);
    const sourceAccount = `G${"D".repeat(55)}`;
    const txHash = "dup-tx";
    const client = {
      getTransaction: jest.fn().mockResolvedValue({
        source: sourceAccount,
        events: [{ type: "deposit", amount: 5, shares: 5 }],
      }),
    };

    await (indexer as any).processTransaction(client as any, txHash, 1);
    await (indexer as any).processTransaction(client as any, txHash, 2);

    expect(indexer.getStore().events).toHaveLength(1);
    expect(indexer.getStore().events[0].txHash).toBe(txHash);
  });

  it("bounds the store when events are ingested through processTransaction()", async () => {
    const cap = 2;
    setMaxEvents(cap);
    const sourceAccount = `G${"E".repeat(55)}`;

    for (let i = 1; i <= cap + 2; i++) {
      const client = {
        getTransaction: jest.fn().mockResolvedValue({
          source: sourceAccount,
          events: [{ type: "deposit", amount: i, shares: i }],
        }),
      };
      await (indexer as any).processTransaction(client as any, `tx-${i}`, i);
    }

    const events = indexer.getStore().events;
    expect(events).toHaveLength(cap);
    expect(events.map((e) => e.txHash)).toEqual(["tx-3", "tx-4"]);
  });
});
