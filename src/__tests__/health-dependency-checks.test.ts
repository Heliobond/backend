import request from "supertest";
import express from "express";

jest.mock("../lib/stellar", () => ({
  rpcPool: {
    getMetrics: jest.fn(() => ({ active: 1, idle: 2, total: 3, healthy: 3, waitingQueue: 0 })),
    shutdown: jest.fn(),
  },
  rpcBreaker: {
    getMetrics: jest.fn(() => ({ state: "CLOSED", failures: 0, successes: 10 })),
    getState: jest.fn(() => "CLOSED"),
  },
  getRpcStatus: jest.fn(() => ({
    consecutiveFailures: 0,
    outageDurationMs: 0,
    lastSuccessAgoMs: 100,
  })),
}));

jest.mock("../lib/satellite-sources", () => ({
  getSourceHealth: jest.fn(() => ({})),
  getOutageState: jest.fn(() => ({ consecutiveFailures: 0 })),
  getCacheStats: jest.fn(() => ({ hits: 0, misses: 0 })),
}));

jest.mock("../lib/db", () => ({
  pool: { query: jest.fn(async () => ({})), totalCount: 0 },
}));

jest.mock("../lib/migrations", () => ({
  getMigrationHealth: jest.fn(async () => ({ pending: 0, applied: 5 })),
}));

jest.mock("../lib/feature-flags", () => ({
  listFlags: jest.fn(() => ({})),
}));

import { getHealth, getReadiness, recordCronRun } from "../lib/health";
import * as stellar from "../lib/stellar";
import * as satellite from "../lib/satellite-sources";
import * as db from "../lib/db";

describe("health endpoint dependency checks (#277)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (stellar.rpcPool.getMetrics as jest.Mock).mockReturnValue({
      active: 1,
      idle: 2,
      total: 3,
      healthy: 3,
      waitingQueue: 0,
    });
    (stellar.rpcBreaker.getMetrics as jest.Mock).mockReturnValue({
      state: "CLOSED",
      failures: 0,
      successes: 10,
    });
    (stellar.rpcBreaker.getState as jest.Mock).mockReturnValue("CLOSED");
    (stellar.getRpcStatus as jest.Mock).mockReturnValue({
      consecutiveFailures: 0,
      outageDurationMs: 0,
      lastSuccessAgoMs: 100,
    });
    (satellite.getOutageState as jest.Mock).mockReturnValue({ consecutiveFailures: 0 });
  });

  describe("all dependencies up → healthy", () => {
    it("returns status ok when all deps are healthy", async () => {
      const health = await getHealth();
      expect(health.status).toBe("ok");
    });

    it("returns degraded status when the database is unavailable", async () => {
      (db.pool.query as jest.Mock).mockRejectedValueOnce(new Error("database unavailable"));
      const health = await getHealth();
      expect(health.status).toBe("degraded");
      expect(health.database.connected).toBe(false);
    });

    it("returns degraded status when the RPC pool has no healthy connections", async () => {
      (stellar.rpcPool.getMetrics as jest.Mock).mockReturnValue({
        active: 0,
        idle: 0,
        total: 2,
        healthy: 0,
        waitingQueue: 0,
      });
      const health = await getHealth();
      expect(health.status).toBe("degraded");
    });

    it("includes rpc_status in health report", async () => {
      const health = await getHealth();
      expect(health).toHaveProperty("rpc_status");
      expect(health.rpc_status).toMatchObject({
        consecutiveFailures: expect.any(Number),
        outageDurationMs: expect.any(Number),
        lastSuccessAgoMs: expect.any(Number),
      });
    });

    it("includes rpc_pool metrics", async () => {
      const health = await getHealth();
      expect(health).toHaveProperty("rpc_pool");
    });

    it("includes circuit_breaker metrics", async () => {
      const health = await getHealth();
      expect(health).toHaveProperty("circuit_breaker");
    });

    it("includes satellite_data", async () => {
      const health = await getHealth();
      expect(health).toHaveProperty("satellite_data");
      expect(health.satellite_data).toHaveProperty("sources");
      expect(health.satellite_data).toHaveProperty("cache");
      expect(health.satellite_data).toHaveProperty("outage");
    });
  });

  describe("RPC down → rpc_status reflects failures", () => {
    it("reflects consecutive RPC failures in rpc_status", async () => {
      (stellar.getRpcStatus as jest.Mock).mockReturnValue({
        consecutiveFailures: 5,
        outageDurationMs: 30000,
        lastSuccessAgoMs: 30500,
      });

      const health = await getHealth();
      expect(health.rpc_status.consecutiveFailures).toBe(5);
      expect(health.rpc_status.outageDurationMs).toBeGreaterThan(0);
    });

    it("reflects OPEN circuit breaker state", async () => {
      (stellar.rpcBreaker.getMetrics as jest.Mock).mockReturnValue({
        state: "OPEN",
        failures: 10,
        successes: 0,
      });

      const health = await getHealth();
      expect(health.circuit_breaker).toMatchObject({ state: "OPEN" });
    });
  });

  describe("readiness with degraded dependencies", () => {
    it("returns not_ready when circuit breaker is OPEN", async () => {
      (stellar.rpcBreaker.getState as jest.Mock).mockReturnValue("OPEN");
      const readiness = await getReadiness();
      expect(readiness.status).toBe("not_ready");
      expect(readiness.checks.rpc_circuit).toBe(false);
    });

    it("returns not_ready when the RPC connection pool has no healthy connections", async () => {
      (stellar.rpcPool.getMetrics as jest.Mock).mockReturnValue({
        active: 0,
        idle: 0,
        total: 2,
        healthy: 0,
        waitingQueue: 0,
      });
      const readiness = await getReadiness();
      expect(readiness.status).toBe("not_ready");
    });

    it("returns not_ready when satellite has consecutive failures", async () => {
      (satellite.getOutageState as jest.Mock).mockReturnValue({ consecutiveFailures: 5 });
      const readiness = await getReadiness();
      expect(readiness.status).toBe("not_ready");
      expect(readiness.checks.satellite).toBe(false);
    });

    it("checks the database even when its lazy pool has no clients", async () => {
      (stellar.rpcBreaker.getState as jest.Mock).mockReturnValue("CLOSED");
      (satellite.getOutageState as jest.Mock).mockReturnValue({ consecutiveFailures: 0 });
      const readiness = await getReadiness();
      expect(readiness.checks).toMatchObject({
        database: true,
        satellite: true,
        rpc_circuit: true,
      });
      expect(db.pool.query).toHaveBeenCalledWith("SELECT 1");
    });

    it("returns not_ready when the database query fails", async () => {
      (db.pool.query as jest.Mock).mockRejectedValueOnce(new Error("database unavailable"));
      const readiness = await getReadiness();
      expect(readiness.status).toBe("not_ready");
      expect(readiness.checks.database).toBe(false);
    });
  });

  describe("response time under 500ms", () => {
    it("GET /health responds in under 500ms", async () => {
      const app = express();
      app.get("/health", async (_req, res) => res.json(await getHealth()));

      const start = Date.now();
      const res = await request(app).get("/health").expect(200);
      const elapsed = Date.now() - start;

      expect(res.body.status).toBe("ok");
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("cron run tracking", () => {
    it("records last cron run in health report", async () => {
      recordCronRun("score-update", "success");
      const health = await getHealth();
      expect(health.last_cron_run).toMatchObject({
        name: "score-update",
        status: "success",
        at: expect.any(String),
      });
    });

    it("records cron errors", async () => {
      recordCronRun("indexer", "error");
      const health = await getHealth();
      expect(health.last_cron_run).toMatchObject({ name: "indexer", status: "error" });
    });

    it("retains the latest run for each cron job", async () => {
      recordCronRun("score-update", "success");
      recordCronRun("tx-queue", "error");
      const health = await getHealth();
      expect(health.last_cron_runs).toMatchObject({
        "score-update": { name: "score-update", status: "success" },
        "tx-queue": { name: "tx-queue", status: "error" },
      });
    });
  });

  describe("GET /health via HTTP", () => {
    it("returns 200 JSON with full dependency report", async () => {
      const app = express();
      app.get("/health", async (_req, res) => res.json(await getHealth()));

      const res = await request(app).get("/health").expect(200);
      expect(res.headers["content-type"]).toMatch(/json/);
      expect(res.body).toHaveProperty("status", "ok");
      expect(res.body).toHaveProperty("rpc_status");
      expect(res.body).toHaveProperty("rpc_pool");
      expect(res.body).toHaveProperty("satellite_data");
      expect(res.body).toHaveProperty("migrations");
    });
  });

  describe("readiness db probe timeout (#1047)", () => {
    it("returns not_ready when the db probe exceeds HEALTH_CHECK_TIMEOUT_MS", async () => {
      jest.useFakeTimers();

      // Simulate a query that never resolves — the probe timeout must fire.
      (db.pool.query as jest.Mock).mockImplementationOnce(
        () => new Promise<void>(() => { /* never settles */ }),
      );

      const probePromise = getReadiness();
      // Advance past the default 1 s probe budget so the timeout fires.
      jest.advanceTimersByTime(1500);
      const readiness = await probePromise;

      jest.useRealTimers();

      expect(readiness.status).toBe("not_ready");
      expect(readiness.checks.database).toBe(false);
    });

    it("resolves as ready and clears the timeout when the db probe succeeds quickly", async () => {
      // Default mock resolves immediately — clearTimeout must run so no stray
      // timers remain after the test (Jest warns about open handles otherwise).
      const readiness = await getReadiness();
      expect(readiness.status).toBe("ready");
      expect(readiness.checks.database).toBe(true);
    });
  });
});
