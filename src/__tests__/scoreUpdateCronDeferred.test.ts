/**
 * Regression tests for #713 — `runHourlyScoreUpdate` counted deferred score
 * updates (RPC unavailable, update queued for later) as successes.
 *
 * During a total RPC outage every project defers, so `successCount ===
 * totalProcessed` and the "all failed" alert never fired. The run was reported
 * as a 100% success rate even though no score changed on-chain.
 *
 * These cases mock `request-queue` so each run is isolated: the real
 * `withProjectLock` caches successful results for 30s at module scope, which
 * makes repeated runs in one file return a cached promise instead of
 * re-invoking the handler.
 */

jest.mock("../lib/registry", () => ({
  getTotalProjects: jest.fn(),
  updateImpactScore: jest.fn(),
  RpcDegradedError: class RpcDegradedError extends Error {
    constructor(message?: string) {
      super(message ?? "RPC is degraded");
      this.name = "RpcDegradedError";
    }
  },
}));

jest.mock("../lib/iot", () => ({ getSolarData: jest.fn() }));
jest.mock("../lib/satellite-sources", () => ({ fetchSatelliteWithFallback: jest.fn() }));
jest.mock("../lib/scoring", () => ({ computeScores: jest.fn() }));
jest.mock("../lib/history", () => ({
  recordScoreHistory: jest.fn(),
  getHistory: jest.fn().mockReturnValue([]),
}));
jest.mock("../lib/duplicate-detection", () => ({
  tryBeginUpdate: jest.fn().mockReturnValue({ allowed: true, key: "k", reason: "" }),
  markCompleted: jest.fn(),
  markFailed: jest.fn(),
}));
jest.mock("../lib/error-limiter", () => ({
  isErrorRateLimited: jest.fn().mockReturnValue(false),
  resetErrorRateLimit: jest.fn(),
}));
jest.mock("../lib/tx-queue", () => ({ enqueue: jest.fn() }));
jest.mock("../lib/email", () => ({ sendAlertIfSignificant: jest.fn().mockResolvedValue(0) }));
jest.mock("../lib/webhooks", () => ({ triggerWebhooks: jest.fn() }));
jest.mock("../lib/websocket", () => ({ broadcastScoreUpdate: jest.fn() }));
jest.mock("../lib/health", () => ({ recordCronRun: jest.fn() }));
jest.mock("../lib/notifications", () => ({ notify: jest.fn().mockResolvedValue(undefined) }));

// Run the handler immediately with no cross-run caching.
jest.mock("../lib/request-queue", () => ({
  withProjectLock: jest.fn(async (_projectId: number, handler: () => Promise<unknown>) =>
    handler(),
  ),
}));

// Mock the logger rather than spying on console: the real one drops info-level
// output under NODE_ENV=test (the "test" env maps to the "warn" threshold), so
// the batch summary this file asserts on would never be emitted.
jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    formatError: jest.fn((e: unknown) => ({ message: String(e) })),
  },
}));

jest.mock("../config", () => ({
  config: { CRON_FAILURE_THRESHOLD: 0.5, IDEMPOTENCY_TTL_MS: 3_600_000 },
}));

import { runHourlyScoreUpdate } from "../lib/scoreUpdateCron";
import { resetIdempotencyState } from "../lib/scoreService";
import { getTotalProjects, updateImpactScore, RpcDegradedError } from "../lib/registry";
import { getSolarData } from "../lib/iot";
import { fetchSatelliteWithFallback } from "../lib/satellite-sources";
import { computeScores } from "../lib/scoring";
import { recordCronRun } from "../lib/health";
import { enqueue } from "../lib/tx-queue";
import { logger } from "../lib/logger";

/** Collects the structured payloads passed to logger.info/error. */
describe("runHourlyScoreUpdate deferred accounting (#713)", () => {
  beforeEach(() => {
    resetIdempotencyState();
    jest.clearAllMocks();
    (getSolarData as jest.Mock).mockReturnValue({
      efficiency_pct: 85,
      power_output_kw: 500,
      max_power_kw: 1000,
    });
    (fetchSatelliteWithFallback as jest.Mock).mockResolvedValue({
      forest_density_pct: 60,
      ndvi_score: 0.6,
    });
    (computeScores as jest.Mock).mockReturnValue({ credit_quality: 85, green_impact: 70 });
    (updateImpactScore as jest.Mock).mockResolvedValue("tx-hash");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const infoCalls = () => (logger.info as jest.Mock).mock.calls;
  const errorCalls = () => (logger.error as jest.Mock).mock.calls;
  const summary = () =>
    infoCalls()
      .filter(([message]) => String(message).includes("hourly score update complete"))
      .map(([, meta]) => meta as Record<string, unknown>)[0];
  const alerts = () =>
    errorCalls()
      .filter(([message]) => String(message).includes("ALERT:"))
      .map(([message]) => String(message));

  it("does not count a deferred update as a success", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(1);
    (updateImpactScore as jest.Mock).mockRejectedValue(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    // The update was queued, not submitted.
    expect(enqueue).toHaveBeenCalledWith(1, 85, 70, "RPC degraded");
    // A full outage must not be summarised as a success run.
    expect(alerts()).toHaveLength(1);
  });

  it("alerts and records an error run when every project is deferred", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(3);
    (updateImpactScore as jest.Mock).mockRejectedValue(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    expect(recordCronRun).toHaveBeenCalledWith("score-update", "error");
    expect(alerts()[0]).toContain("deferred");
    // The alert should say how much is queued, so operators can gauge the backlog.
    expect(alerts()[0]).toContain("3");
  });

  it("includes deferredCount in the batch summary log", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(2);
    (updateImpactScore as jest.Mock)
      .mockResolvedValueOnce("tx-1")
      .mockRejectedValueOnce(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    // One real success, one deferred: a partial outage stays a success run.
    expect(recordCronRun).toHaveBeenCalledWith("score-update", "success");
    expect(summary()).toMatchObject({ successCount: 1, deferredCount: 1, failureCount: 0 });
  });

  it("still records success when every update actually lands on-chain", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(2);

    await runHourlyScoreUpdate();

    expect(recordCronRun).toHaveBeenCalledWith("score-update", "success");
    expect(alerts()).toHaveLength(0);
    expect(summary()).toMatchObject({ successCount: 2, deferredCount: 0, failureCount: 0 });
  });

  it("keeps the all-failed alert distinct from the all-deferred alert", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(2);
    (updateImpactScore as jest.Mock).mockRejectedValue(new Error("submit failed"));

    await runHourlyScoreUpdate();

    expect(recordCronRun).toHaveBeenCalledWith("score-update", "error");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain("failed");
    expect(alerts()[0]).not.toContain("deferred");
  });

  it("treats a mixed failure and deferred batch as a normal run", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(2);
    (updateImpactScore as jest.Mock)
      .mockRejectedValueOnce(new Error("submit failed"))
      .mockRejectedValueOnce(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    // Not every project failed, and not every project deferred, so this is a
    // partial run rather than a systemic outage.
    expect(recordCronRun).toHaveBeenCalledWith("score-update", "success");
    expect(alerts().filter((a) => a.includes("ALERT: ALL"))).toHaveLength(0);
    expect(summary()).toMatchObject({ successCount: 0, deferredCount: 1, failureCount: 1 });
  });

  it("does not alert when a run defers nothing and fails nothing", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(1);

    await runHourlyScoreUpdate();

    expect(alerts()).toHaveLength(0);
    expect(recordCronRun).toHaveBeenCalledWith("score-update", "success");
  });
});
