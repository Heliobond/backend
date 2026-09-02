import { indexer } from "../lib/indexer";

describe("EventIndexer", () => {
  beforeEach(() => {
    (indexer as any).store = {
      events: [],
      cursor: 0,
      lastUpdated: Date.now(),
    };
  });

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
