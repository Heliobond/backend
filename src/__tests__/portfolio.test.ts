import request from "supertest";
import express from "express";
import portfolioRouter from "../routes/portfolio";
import { indexer } from "../lib/indexer";

const app = express();
app.use("/api/portfolio", portfolioRouter);

const ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ADDRESS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

beforeAll(() => {
  // Seed the singleton indexer so the endpoint has events to value.
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
  indexer.addEvent({
    id: "portfolio-test-deposit-2",
    type: "deposit",
    address: ADDRESS,
    amount: 250,
    shares: 8,
    timestamp: 1718150401000,
    ledger: 2,
    txHash: "testtxhash2",
  });
  // Same share count (42 + 8 = 50) as ADDRESS so the address-keyed price is
  // the only variable when comparing the two portfolios.
  indexer.addEvent({
    id: "portfolio-test-deposit-other-1",
    type: "deposit",
    address: OTHER_ADDRESS,
    amount: 275,
    shares: 42,
    timestamp: 1718150402000,
    ledger: 3,
    txHash: "testtxhash3",
  });
  indexer.addEvent({
    id: "portfolio-test-deposit-other-2",
    type: "deposit",
    address: OTHER_ADDRESS,
    amount: 275,
    shares: 8,
    timestamp: 1718150403000,
    ledger: 4,
    txHash: "testtxhash4",
  });
});

describe("GET /api/portfolio/:address — deterministic pricing", () => {
  it("returns 200 with correct fields", async () => {
    const res = await request(app).get(`/api/portfolio/${ADDRESS}`).expect(200);
    expect(res.body).toHaveProperty("address", ADDRESS);
    expect(res.body).toHaveProperty("current_shares");
    expect(res.body).toHaveProperty("current_value");
    expect(res.body).toHaveProperty("events");
  });

  it("returns the same current_value across requests within the same hour", async () => {
    const first = await request(app).get(`/api/portfolio/${ADDRESS}`).expect(200);
    const second = await request(app).get(`/api/portfolio/${ADDRESS}`).expect(200);

    expect(first.body.current_shares).toBe(50);
    expect(second.body.current_value).toBe(first.body.current_value);
  });

  it("keeps current_value in the documented 1.5x–2.0x range of current_shares", async () => {
    const res = await request(app).get(`/api/portfolio/${ADDRESS}`).expect(200);
    const ratio = res.body.current_value / res.body.current_shares;
    expect(ratio).toBeGreaterThanOrEqual(1.5);
    expect(ratio).toBeLessThanOrEqual(2.0);
  });

  it("varies current_value by address for equal share counts", async () => {
    const a = await request(app).get(`/api/portfolio/${ADDRESS}`).expect(200);
    const b = await request(app).get(`/api/portfolio/${OTHER_ADDRESS}`).expect(200);

    expect(a.body.current_shares).toBe(50);
    expect(b.body.current_shares).toBe(50);
    // Same shares, different address seed: prices must not collapse to one value.
    expect(b.body.current_value).not.toBe(a.body.current_value);
  });
});
