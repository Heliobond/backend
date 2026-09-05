import request from "supertest";
import express from "express";
import { recordRequest, getMetrics } from "../lib/metrics";
import { recordCronRun } from "../lib/health";

jest.mock("../lib/stellar", () => ({
  rpcPool: {
    getMetrics: jest.fn(() => ({ active: 0, idle: 1, total: 1, waitingQueue: 0 })),
    shutdown: jest.fn(),
  },
  rpcBreaker: {
    getMetrics: jest.fn(() => ({ state: "CLOSED", failures: 0, successes: 0 })),
    getState: jest.fn(() => "CLOSED"),
  },
  getRpcStatus: jest.fn(() => ({
    consecutiveFailures: 0,
    outageDurationMs: 0,
    lastSuccessAgoMs: 50,
  })),
}));

jest.mock("../lib/satellite-sources", () => ({
  getSourceHealth: jest.fn(() => ({})),
  getOutageState: jest.fn(() => ({ consecutiveFailures: 0 })),
  getCacheStats: jest.fn(() => ({ hits: 0, misses: 0 })),
}));

jest.mock("../lib/migrations", () => ({
  getMigrationHealth: jest.fn(async () => ({ pending: 0, applied: 3 })),
}));

jest.mock("../lib/feature-flags", () => ({
  listFlags: jest.fn(() => ({})),
}));

describe("metrics collection (#283)", () => {
  describe("recordRequest / getMetrics", () => {
    it("getMetrics returns a snapshot object", () => {
      const snapshot = getMetrics();
      expect(snapshot).toHaveProperty("timestamp");
      expect(snapshot).toHaveProperty("uptime_seconds");
      expect(snapshot).toHaveProperty("requests");
      expect(snapshot).toHaveProperty("by_method");
      expect(snapshot).toHaveProperty("by_path");
    });

    it("requests snapshot has all required counters", () => {
      const { requests } = getMetrics();
      expect(requests).toHaveProperty("total_requests");
      expect(requests).toHaveProperty("total_errors");
      expect(requests).toHaveProperty("total_success");
      expect(requests).toHaveProperty("error_rate");
      expect(requests).toHaveProperty("success_rate");
      expect(requests).toHaveProperty("avg_response_time_ms");
      expect(requests).toHaveProperty("requests_per_minute");
      expect(requests).toHaveProperty("errors_per_minute");
    });

    it("uptime_seconds is a non-negative number", () => {
      const snapshot = getMetrics();
      expect(typeof snapshot.uptime_seconds).toBe("number");
      expect(snapshot.uptime_seconds).toBeGreaterThanOrEqual(0);
    });

    it("timestamp is a valid ISO string", () => {
      const snapshot = getMetrics();
      expect(() => new Date(snapshot.timestamp)).not.toThrow();
      expect(new Date(snapshot.timestamp).getTime()).toBeGreaterThan(0);
    });

    it("records a successful request and increments counters", () => {
      const before = getMetrics();
      recordRequest("GET", "/v1/projects", 200, 45);
      const after = getMetrics();
      expect(after.requests.total_requests).toBeGreaterThan(before.requests.total_requests);
    });

    it("records an error request and increments error counters", () => {
      const before = getMetrics();
      recordRequest("POST", "/v1/admin/score-update", 500, 120);
      const after = getMetrics();
      expect(after.requests.total_errors).toBeGreaterThan(before.requests.total_errors);
    });

    it("error_rate is between 0 and 1", () => {
      recordRequest("GET", "/v1/iot/solar/1", 200, 10);
      recordRequest("GET", "/v1/iot/solar/2", 400, 5);
      const { requests } = getMetrics();
      expect(requests.error_rate).toBeGreaterThanOrEqual(0);
      expect(requests.error_rate).toBeLessThanOrEqual(1);
    });

    it("success_rate + error_rate equals 1 when there are requests", () => {
      recordRequest("GET", "/v1/projects", 200, 30);
      const { requests } = getMetrics();
      if (requests.total_requests > 0) {
        const sum = Math.round((requests.success_rate + requests.error_rate) * 10000) / 10000;
        expect(sum).toBeCloseTo(1, 4);
      }
    });
  });

  describe("GET /v1/metrics endpoint", () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.get("/v1/metrics", (_req, res) => res.json(getMetrics()));
    });

    it("returns 200", async () => {
      await request(app).get("/v1/metrics").expect(200);
    });

    it("returns JSON content-type", async () => {
      const res = await request(app).get("/v1/metrics");
      expect(res.headers["content-type"]).toMatch(/json/);
    });

    it("response body includes requests snapshot", async () => {
      const res = await request(app).get("/v1/metrics").expect(200);
      expect(res.body).toHaveProperty("requests");
      expect(res.body).toHaveProperty("uptime_seconds");
      expect(res.body).toHaveProperty("timestamp");
    });

    it("total_requests is numeric", async () => {
      const res = await request(app).get("/v1/metrics").expect(200);
      expect(typeof res.body.requests.total_requests).toBe("number");
    });
  });

  describe("cron job metrics via health (#283 cron_job_duration_seconds analogue)", () => {
    it("cron runs are recorded in the health report", async () => {
      const { getHealth } = await import("../lib/health");
      recordCronRun("score-update", "success");
      const health = await getHealth();
      expect(health.last_cron_run).toMatchObject({
        name: "score-update",
        status: "success",
        at: expect.any(String),
      });
    });

    it("cron error status is captured", async () => {
      const { getHealth } = await import("../lib/health");
      recordCronRun("indexer", "error");
      const health = await getHealth();
      expect(health.last_cron_run).toMatchObject({ status: "error" });
    });
  });

  describe("Stellar RPC metrics", () => {
    it("getRpcStatus returns numeric consecutive failures", async () => {
      const { getRpcStatus } = await import("../lib/stellar");
      const status = getRpcStatus();
      expect(typeof status.consecutiveFailures).toBe("number");
      expect(typeof status.outageDurationMs).toBe("number");
      expect(typeof status.lastSuccessAgoMs).toBe("number");
    });

    it("health report includes rpc_status with stellar fields", async () => {
      const { getHealth } = await import("../lib/health");
      const health = await getHealth();
      expect(health.rpc_status).toHaveProperty("consecutiveFailures");
      expect(health.rpc_status).toHaveProperty("outageDurationMs");
      expect(health.rpc_status).toHaveProperty("lastSuccessAgoMs");
    });
  });
});
