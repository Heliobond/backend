/**
 * Tests for GET /v1/projects/:id/price-history (#769).
 *
 * The registry contract calls are mocked so the route logic (shape,
 * bucketing, range filter, error mapping, cache header) is exercised
 * without an RPC dependency. `buildPricePoints` is unit-tested directly
 * for its bucketing / range-filter semantics.
 */

import request from "supertest";
import express, { Express } from "express";

jest.mock("../lib/registry", () => {
  class ProjectNotFoundError extends Error {
    constructor(projectId: number) {
      super(`Project ${projectId} not found or archived`);
      this.name = "ProjectNotFoundError";
    }
  }
  return {
    getScoreHistory: jest.fn(),
    getInterestRate: jest.fn(),
    ProjectNotFoundError,
  };
});

import priceHistoryRouter, { buildPricePoints, type PricePoint } from "../routes/priceHistory";
import { errorHandler } from "../middleware/errors";
import {
  getScoreHistory,
  getInterestRate,
  ProjectNotFoundError,
  type OnChainScoreHistoryEntry,
} from "../lib/registry";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/projects/:id/price-history", priceHistoryRouter);
  app.use(errorHandler);
  return app;
}

// Fixed reference timestamps (contract stores unix seconds).
const D1 = Math.floor(Date.UTC(2026, 8, 28, 12, 0, 0) / 1000); // 2026-09-28
const D2 = Math.floor(Date.UTC(2026, 8, 29, 12, 0, 0) / 1000); // 2026-09-29
const D3 = Math.floor(Date.UTC(2026, 8, 30, 12, 0, 0) / 1000); // 2026-09-30

const FIXTURE_HISTORY: OnChainScoreHistoryEntry[] = [
  { timestamp: D1, credit_quality: 70, green_impact: 60 },
  { timestamp: D2, credit_quality: 75, green_impact: 62 },
  { timestamp: D3, credit_quality: 80, green_impact: 65 },
];
const FIXTURE_RATE_BPS = 400; // 4%

describe("GET /v1/projects/:id/price-history", () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    (getScoreHistory as jest.Mock).mockResolvedValue(FIXTURE_HISTORY);
    (getInterestRate as jest.Mock).mockResolvedValue(FIXTURE_RATE_BPS);
    app = buildApp();
  });

  it("returns PricePoint[] in ascending date order matching the frontend contract", async () => {
    const res = await request(app).get("/v1/projects/27/price-history").expect(200);

    expect(res.body.project_id).toBe(27);
    expect(res.body.interval).toBe("day");
    expect(res.body.count).toBe(3);
    expect(res.body.points).toEqual([
      { date: "2026-09-28", price: 96.15, yield: 4 },
      { date: "2026-09-29", price: 96.15, yield: 4 },
      { date: "2026-09-30", price: 96.15, yield: 4 },
    ]);
    // Ascending date order (contract check the acceptance criteria calls out).
    const dates = res.body.points.map((p: PricePoint) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("sets a short public Cache-Control on the response", async () => {
    const res = await request(app).get("/v1/projects/1/price-history").expect(200);
    expect(res.headers["cache-control"]).toMatch(/public, max-age=60/);
  });

  it("supports the weekly interval and buckets to the Monday of the ISO week", async () => {
    const res = await request(app).get("/v1/projects/1/price-history?interval=week").expect(200);
    // All three fixture points fall in the week starting Mon 2026-09-28.
    expect(res.body.interval).toBe("week");
    expect(res.body.count).toBe(1);
    expect(res.body.points[0].date).toBe("2026-09-28");
  });

  it("returns 400 when from > to", async () => {
    const res = await request(app)
      .get("/v1/projects/1/price-history?from=2000&to=1000")
      .expect(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("returns 400 when interval is not day or week", async () => {
    const res = await request(app)
      .get("/v1/projects/1/price-history?interval=fortnight")
      .expect(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(res.body.error.message).toMatch(/interval/);
  });

  it("returns 404 when the project is unknown or archived on the registry", async () => {
    (getScoreHistory as jest.Mock).mockRejectedValueOnce(new ProjectNotFoundError(999));
    (getInterestRate as jest.Mock).mockResolvedValueOnce(0);

    const res = await request(app).get("/v1/projects/999/price-history").expect(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("propagates 404 when only the rate lookup errors with ProjectNotFound", async () => {
    (getScoreHistory as jest.Mock).mockResolvedValueOnce([]);
    (getInterestRate as jest.Mock).mockRejectedValueOnce(new ProjectNotFoundError(42));

    await request(app).get("/v1/projects/42/price-history").expect(404);
  });

  it("only calls on-chain reads, never fabricates data", async () => {
    await request(app).get("/v1/projects/7/price-history").expect(200);
    expect(getScoreHistory).toHaveBeenCalledWith(7);
    expect(getInterestRate).toHaveBeenCalledWith(7);
  });
});

describe("buildPricePoints (unit)", () => {
  it("filters by inclusive from/to range", () => {
    const points = buildPricePoints(FIXTURE_HISTORY, FIXTURE_RATE_BPS, {
      from: D2 * 1000,
      to: D3 * 1000,
      interval: "day",
    });
    expect(points.map((p) => p.date)).toEqual(["2026-09-29", "2026-09-30"]);
  });

  it("returns [] when no history entries match the range", () => {
    const points = buildPricePoints(FIXTURE_HISTORY, FIXTURE_RATE_BPS, {
      from: Date.UTC(2027, 0, 1),
      to: Date.UTC(2027, 0, 2),
      interval: "day",
    });
    expect(points).toEqual([]);
  });

  it("keeps the last entry per bucket when multiple fall in the same day", () => {
    const sameDay: OnChainScoreHistoryEntry[] = [
      { timestamp: D1, credit_quality: 70, green_impact: 60 },
      // 6h later, still same UTC day
      { timestamp: D1 + 6 * 3600, credit_quality: 72, green_impact: 61 },
    ];
    const points = buildPricePoints(sameDay, FIXTURE_RATE_BPS, { interval: "day" });
    expect(points).toHaveLength(1);
    expect(points[0].date).toBe("2026-09-28");
  });
});
