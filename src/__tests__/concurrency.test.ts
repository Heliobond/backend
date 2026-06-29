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

  it("should sequentially process simultaneous transactions through the lock queue", async () => {
    const submissions = [1, 2, 3, 4, 5].map(() =>
      signAndSubmit(mockClient, preparedXdr, mockKeypair),
    );

    const results = await Promise.all(submissions);

    expect(results).toHaveLength(5);
    results.forEach((hash) => {
      expect(hash).toBe("mock-tx-hash-12345");
    });

    expect(mockClient.getLedgerEntries).toHaveBeenCalledTimes(5);
    expect(mockClient.sendTransaction).toHaveBeenCalledTimes(5);
  }, 15000); // <--- RIGHT HERE
});
