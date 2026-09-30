import request from "supertest";
import express from "express";
import portfolioRouter from "../routes/portfolio";
import { errorHandler } from "../middleware/errors";
import { indexer } from "../lib/indexer";
import * as vault from "../lib/vault";

jest.mock("../lib/vault", () => ({
  ...jest.requireActual("../lib/vault"),
  getPortfolio: jest.fn(),
}));

const app = express();
app.use("/api/portfolio", portfolioRouter);
app.use(errorHandler);

const ADDRESS = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";

beforeAll(() => {
  indexer.addEvent({
    id: "portfolio-test-deposit-1",
    type: "deposit",
    address: ADDRESS,
    amount: 500,
    shares: 42,
    timestamp: 1718150400000,
    ledger: 1,
    txHash: "testtxhash1",
  });
  (vault.getPortfolio as jest.Mock).mockResolvedValue({
    shares: "500000000",
    usdc_value: "750000000",
    claimable_yield: "10000000",
    share_of_pool_bps: 250,
    total_deposited: "500000000",
  });
});

describe("GET /api/portfolio/:address", () => {
  it("returns vault portfolio fields plus indexed events", async () => {
    const res = await request(app).get(`/api/portfolio/${ADDRESS}`).expect(200);
    expect(res.body).toMatchObject({
      address: ADDRESS,
      shares: "500000000",
      usdc_value: "750000000",
      claimable_yield: "10000000",
      share_of_pool_bps: 250,
      total_deposited: "500000000",
    });
    expect(res.body.usdc_value_display).toBe(vault.i128ToDecimal("750000000", 7));
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].id).toBe("portfolio-test-deposit-1");
  });

  it("returns 400 for a malformed address", async () => {
    await request(app).get("/api/portfolio/not-an-address").expect(400);
  });
});
