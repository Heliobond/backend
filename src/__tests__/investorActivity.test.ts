import request from "supertest";
import express from "express";
import investorActivityRouter from "../routes/investorActivity";
import { errorHandler, ApiError } from "../middleware/errors";
import { indexer } from "../lib/indexer";

jest.mock("../lib/indexer", () => ({
  indexer: { getActivity: jest.fn(), getPendingWithdrawals: jest.fn() },
}));

const getActivity = indexer.getActivity as jest.Mock;
const getPending = indexer.getPendingWithdrawals as jest.Mock;

const app = express();
app.use("/v1/investors", investorActivityRouter);
app.use(errorHandler);

const ADDRESS = `G${"A".repeat(55)}`;

describe("GET /v1/investors/:address/activity", () => {
  beforeEach(() => getActivity.mockResolvedValue({ events: [], next_cursor: null }));

  it("returns the page from the indexer with the default limit", async () => {
    getActivity.mockResolvedValue({ events: [{ tx_hash: "t1" }], next_cursor: "abc" });
    const res = await request(app).get(`/v1/investors/${ADDRESS}/activity`).expect(200);
    expect(res.body).toEqual({ address: ADDRESS, events: [{ tx_hash: "t1" }], next_cursor: "abc" });
    expect(getActivity).toHaveBeenCalledWith(ADDRESS, null, 50);
  });

  it("passes a trimmed cursor and explicit limit through", async () => {
    await request(app)
      .get(`/v1/investors/${ADDRESS}/activity?cursor=%20xyz%20&limit=200`)
      .expect(200);
    expect(getActivity).toHaveBeenCalledWith(ADDRESS, "xyz", 200);
  });

  it.each(["0", "201", "abc", "1.5", "-3"])("rejects limit=%s with 400", async (limit) => {
    await request(app).get(`/v1/investors/${ADDRESS}/activity?limit=${limit}`).expect(400);
    expect(getActivity).not.toHaveBeenCalled();
  });

  it("rejects a repeated cursor parameter with 400", async () => {
    await request(app).get(`/v1/investors/${ADDRESS}/activity?cursor=a&cursor=b`).expect(400);
  });

  it("rejects an over-long address with 400", async () => {
    await request(app)
      .get(`/v1/investors/${"A".repeat(129)}/activity`)
      .expect(400);
  });

  it("forwards indexer errors such as 503 when persistence is disabled", async () => {
    getActivity.mockRejectedValue(new ApiError(503, "indexer_disabled", "disabled"));
    const res = await request(app).get(`/v1/investors/${ADDRESS}/activity`).expect(503);
    expect(res.body.error.code).toBe("indexer_disabled");
  });
});

describe("GET /v1/investors/:address/pending-withdrawals", () => {
  it("returns pending withdrawals for the address", async () => {
    getPending.mockResolvedValue([{ tx_hash: "q1", shares: 5 }]);
    const res = await request(app).get(`/v1/investors/${ADDRESS}/pending-withdrawals`).expect(200);
    expect(res.body).toEqual({
      address: ADDRESS,
      pending_withdrawals: [{ tx_hash: "q1", shares: 5 }],
    });
    expect(getPending).toHaveBeenCalledWith(ADDRESS);
  });
});
