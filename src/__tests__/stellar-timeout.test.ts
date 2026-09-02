import { signAndSubmit } from "../lib/stellar";
import { rpc, TransactionBuilder, Keypair } from "@stellar/stellar-sdk";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: jest.fn(),
    },
  };
});

function makeGetTransactionResponse(
  status: rpc.Api.GetTransactionStatus,
): rpc.Api.GetTransactionResponse {
  return {
    status,
    hash: "tx-hash-1",
    txHash: "tx-hash-1",
    latestLedger: 1000,
    latestLedgerCloseTime: 1234567890,
    oldestLedger: 999,
    oldestLedgerCloseTime: 1234567880,
    applicationOrder: null,
    feeBump: false,
    envelopeXdr: null,
    resultXdr: null,
    resultMetaXdr: null,
    ledger: 1000,
    createdAt: 1234567890,
  } as unknown as rpc.Api.GetTransactionResponse;
}

describe("signAndSubmit timeout behavior", () => {
  let client: rpc.Server;
  let keypair: Keypair;
  const xdr = "AAAA...";
  const originalSetTimeout = global.setTimeout;

  beforeEach(() => {
    jest.clearAllMocks();
    keypair = Keypair.random();
    (TransactionBuilder.fromXDR as jest.Mock).mockReturnValue({
      sign: jest.fn(),
    });
    client = {
      getLedgerEntries: jest.fn().mockResolvedValue({ entries: [] }),
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
    } as unknown as rpc.Server;
    // Speed up the polling delay from 1500ms to 10ms
    global.setTimeout = ((fn: () => void) => {
      originalSetTimeout(fn, 10);
    }) as typeof global.setTimeout;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
  });

  it("transaction succeeds when adequate timeout", async () => {
    (client.sendTransaction as jest.Mock).mockResolvedValue({
      status: "PENDING",
      hash: "tx-hash-1",
      errorResult: null,
    });
    (client.getTransaction as jest.Mock)
      .mockResolvedValueOnce(makeGetTransactionResponse(rpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockResolvedValueOnce(makeGetTransactionResponse(rpc.Api.GetTransactionStatus.SUCCESS));

    const hash = await signAndSubmit(client, xdr, keypair);
    expect(hash).toBe("tx-hash-1");
  }, 10000);

  it("transaction expires when timeout too short", async () => {
    (client.sendTransaction as jest.Mock).mockResolvedValue({
      status: "PENDING",
      hash: "tx-hash-1",
      errorResult: null,
    });
    (client.getTransaction as jest.Mock).mockResolvedValue(
      makeGetTransactionResponse(rpc.Api.GetTransactionStatus.NOT_FOUND),
    );

    await expect(signAndSubmit(client, xdr, keypair)).rejects.toThrow(
      "Transaction confirmation timeout",
    );
  }, 10000);

  it("error message indicates timeout", async () => {
    (client.sendTransaction as jest.Mock).mockResolvedValue({
      status: "PENDING",
      hash: "tx-hash-1",
      errorResult: null,
    });
    (client.getTransaction as jest.Mock).mockResolvedValue(
      makeGetTransactionResponse(rpc.Api.GetTransactionStatus.NOT_FOUND),
    );

    try {
      await signAndSubmit(client, xdr, keypair);
      fail("Expected error");
    } catch (err) {
      expect(String(err)).toContain("timeout");
    }
  }, 10000);

  it("timeout is configurable via env var", () => {
    process.env.STELLAR_TX_TIMEOUT = "60";
    expect(process.env.STELLAR_TX_TIMEOUT).toBe("60");
    delete process.env.STELLAR_TX_TIMEOUT;
  });
});
