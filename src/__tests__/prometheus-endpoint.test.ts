import request from "supertest";
import express from "express";
import { register, httpRequestsTotal, httpRequestDuration, stellarRpcTotal, stellarRpcDuration, cronJobTotal, cronJobDuration, txSubmissionTotal, circuitBreakerState } from "../lib/prometheus";
import { prometheusMiddleware } from "../middleware/prometheusMiddleware";

jest.mock("../lib/stellar", () => ({
  rpcPool: { getMetrics: jest.fn(() => ({ active: 0, idle: 1, total: 1 })), shutdown: jest.fn() },
  rpcBreaker: { getMetrics: jest.fn(() => ({ state: "CLOSED" })), getState: jest.fn(() => "CLOSED") },
  getRpcStatus: jest.fn(() => ({ consecutiveFailures: 0, outageDurationMs: 0, lastSuccessAgoMs: 50 })),
}));

afterEach(async () => {
  register.resetMetrics();
});

describe("Prometheus /metrics endpoint (#201)", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(prometheusMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));
    app.get("/metrics", async (_req, res) => {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    });
  });

  it("returns Prometheus text format", async () => {
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain|application\/openmetrics/);
  });

  it("includes default Node.js metrics", async () => {
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("process_cpu");
  });

  it("includes HTTP request metrics after a request", async () => {
    await request(app).get("/test");
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("http_requests_total");
    expect(res.text).toContain("http_request_duration_seconds");
  });

  it("registers Stellar RPC metric names", async () => {
    stellarRpcTotal.inc({ operation: "sendTransaction", result: "success" });
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("stellar_rpc_calls_total");
  });

  it("registers Stellar RPC duration histogram", async () => {
    const end = stellarRpcDuration.startTimer({ operation: "getTransaction" });
    end();
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("stellar_rpc_call_duration_seconds");
  });

  it("registers cron job metrics", async () => {
    cronJobTotal.inc({ job: "score-update", result: "success" });
    const end = cronJobDuration.startTimer({ job: "score-update" });
    end();
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("cron_job_runs_total");
    expect(res.text).toContain("cron_job_duration_seconds");
  });

  it("registers transaction submission metrics", async () => {
    txSubmissionTotal.inc({ result: "success" });
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("stellar_tx_submissions_total");
  });

  it("registers circuit breaker state gauge", async () => {
    circuitBreakerState.set({ name: "StellarRPC" }, 0);
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("circuit_breaker_state");
  });

  it("HTTP metrics are labeled by method and status code", async () => {
    await request(app).get("/test");
    const res = await request(app).get("/metrics");
    expect(res.text).toMatch(/http_requests_total\{.*method="GET"/);
    expect(res.text).toMatch(/http_requests_total\{.*status_code="200"/);
  });
});
