import { Keypair, TransactionBuilder, Account, Networks } from "@stellar/stellar-sdk";
import { signAndSubmit } from "../lib/stellar";

const mockRandomKeypair = Keypair.random();

jest.mock("../lib/stellar", () => {
  const actual = jest.requireActual("../lib/stellar");
  return {
    ...actual,
    getAdminKeypair: () => mockRandomKeypair,
  };
});

describe("Stellar Concurrency and Sequence Management", () => {
  let mockClient: any;
  let mockKeypair: Keypair;
  let preparedXdr: string;

  beforeEach(() => {
    mockKeypair = mockRandomKeypair;

    const account = new Account(mockKeypair.publicKey(), "100");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(60)
      .build();
    preparedXdr = tx.toXDR();

    mockClient = {
      getLedgerEntries: jest.fn().mockResolvedValue({
        entries: [
          {
            val: {
              account: () => ({
                seqNum: () => ({ toString: () => "105" }),
              }),
            },
          },
        ],
      }),
      sendTransaction: jest.fn().mockResolvedValue({
        status: "PENDING",
        hash: "mock-tx-hash-12345",
      }),
      getTransaction: jest.fn().mockResolvedValue({
        status: "SUCCESS",
      }),
    };
  });

  it("should prevent transaction replays for simultaneous duplicate transactions", async () => {
    // Modify preparedXdr to have a sufficiently high sequence so the first one succeeds
    // The mocked getLedgerEntries returns "105", so if our sequence is 106, it succeeds.
    // The previous Account("100") created tx with sequence "101". 101 <= 105 so it gets rejected.
    // Let's create an XDR with sequence 106 (Account "105")
    const account105 = new Account(mockKeypair.publicKey(), "105");
    const tx = new TransactionBuilder(account105, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(60)
      .build();
    const preparedXdr106 = tx.toXDR();

    const submissions = [1, 2, 3, 4, 5].map(() =>
      signAndSubmit(mockClient, preparedXdr106, mockKeypair).catch((e) => e),
    );

    const results = await Promise.all(submissions);

    // The first transaction should succeed (it passes the sequence guard)
    expect(results[0]).toBe("mock-tx-hash-12345");

    // The next four should be rejected immediately by the localSequenceTracker
    for (let i = 1; i < 5; i++) {
      expect(results[i]).toBeInstanceOf(Error);
      expect((results[i] as Error).message).toContain("Stale sequence number detected");
    }

    // Only the first one should have proceeded to fetch from chain and send
    expect(mockClient.getLedgerEntries).toHaveBeenCalledTimes(1);
    expect(mockClient.sendTransaction).toHaveBeenCalledTimes(1);
  }, 15000);
});
