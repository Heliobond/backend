/**
 * HTTP route tests for `src/routes/dashboard.ts` (issue #679).
 *
 * Mounted on a minimal Express app with the shared `notFoundHandler` /
 * `errorHandler`, following `routes.test.ts`. The `lib/analytics` functions are
 * mocked at the module boundary so the suite is deterministic and offline
 * (no DB / Stellar RPC).
 *
 * NOTE: the real app serves this router at `/v1/dashboards` and `/api/dashboard`;
 * this suite mounts it at `/v1/dashboard`. The prefix is not under test.
 */
import request from "supertest";
import express, { Express } from "express";
import dashboardRouter from "../routes/dashboard";
import { errorHandler, notFoundHandler } from "../middleware/errors";

jest.mock("../lib/analytics", () => ({
  collectScores: jest.fn(),
  portfolioSummary: jest.fn(),
  rankPerformers: jest.fn(),
  scoreDistribution: jest.fn(),
  projectTimeSeries: jest.fn(),
  summaryToCsv: jest.fn(),
}));

import {
  collectScores,
  portfolioSummary,
  rankPerformers,
  scoreDistribution,
  projectTimeSeries,
  summaryToCsv,
} from "../lib/analytics";

const mockedCollect = collectScores as jest.Mock;
const mockedSummary = portfolioSummary as jest.Mock;
const mockedPerformers = rankPerformers as jest.Mock;
const mockedDistribution = scoreDistribution as jest.Mock;
const mockedTimeSeries = projectTimeSeries as jest.Mock;
const mockedCsv = summaryToCsv as jest.Mock;

const SCORES = [{ project_id: 1 }, { project_id: 2 }] as unknown[];

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/dashboard", dashboardRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("dashboard routes (#679)", () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedCollect.mockResolvedValue(SCORES);
    mockedSummary.mockReturnValue({ total_projects: 2, avg_credit_quality: 50 });
    mockedPerformers.mockReturnValue({ top: [{ project_id: 1 }], bottom: [{ project_id: 2 }] });
    mockedDistribution.mockReturnValue([{ bucket: 0, count: 2 }]);
    mockedTimeSeries.mockReturnValue([{ timestamp: 1, score: 10 }]);
    mockedCsv.mockReturnValue("project_id,credit_quality\n1,50\n");
    app = buildApp();
  });

  it("GET /summary returns the portfolio summary", async () => {
    const res = await request(app).get("/v1/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_projects: 2, avg_credit_quality: 50 });
    expect(mockedSummary).toHaveBeenCalledWith(SCORES);
  });

  it("GET /performers passes the (bounded) limit through", async () => {
    const res = await request(app).get("/v1/dashboard/performers?limit=5");
    expect(res.status).toBe(200);
    expect(mockedPerformers).toHaveBeenCalledWith(SCORES, 5);

    // A too-large limit is clamped to 50.
    mockedPerformers.mockClear();
    await request(app).get("/v1/dashboard/performers?limit=500");
    expect(mockedPerformers).toHaveBeenCalledWith(SCORES, 50);
  });

  it("GET /distribution selects the field and bucket count", async () => {
    const res = await request(app).get("/v1/dashboard/distribution?field=green_impact&bucket=5");
    expect(res.status).toBe(200);
    expect(res.body.field).toBe("green_impact");
    expect(res.body.buckets).toEqual([{ bucket: 0, count: 2 }]);
    expect(mockedDistribution).toHaveBeenCalledWith(SCORES, "green_impact", 5);
  });

  it("GET /distribution defaults to credit_quality", async () => {
    const res = await request(app).get("/v1/dashboard/distribution");
    expect(res.status).toBe(200);
    expect(res.body.field).toBe("credit_quality");
  });

  it("GET /timeseries/:id returns the project points", async () => {
    const res = await request(app).get("/v1/dashboard/timeseries/1?from=1&to=2");
    expect(res.status).toBe(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body.points).toEqual([{ timestamp: 1, score: 10 }]);
  });

  it("GET /timeseries/:id rejects an invalid id with 400", async () => {
    const res = await request(app).get("/v1/dashboard/timeseries/abc");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("GET /export sends the CSV with the right headers", async () => {
    const res = await request(app).get("/v1/dashboard/export");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/dashboard-export\.csv/);
    expect(res.text).toBe("project_id,credit_quality\n1,50\n");
  });

  it("surfaces an upstream failure as a 500", async () => {
    mockedCollect.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app).get("/v1/dashboard/summary");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});
