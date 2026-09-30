/**
 * Regression tests for #713: deferred score updates must not be counted as
 * successes, and a total RPC outage must raise an alert.
 *
 * Before the fix, a project whose update was queued because the RPC was
 * unavailable incremented `successCount`. When every project was deferred
 * (a complete outage) the batch reported `successCount === totalProcessed`,
 * so the "all failed" alert could not fire and the run was logged as a clean
 * success while nothing had been written on-chain.
 *
 * These tests drive the real cron handler with a real scoreService, mocking
 * only I/O, so the deferred path is exercised end to end.
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

// The real withProjectLock keeps an in-process lock per project. Because every
// test in this file runs in one process and reuses the same project ids, the
// second and later runs find the lock held, skip the callback entirely, and
// leave every counter at zero - which is what made the pre-existing suite
// order-dependent and flaky. Running the callback directly isolates the
// accounting this file is actually testing.
jest.mock("../lib/request-queue", () => ({
  withProjectLock: async (_projectId: number, fn: () => Promise<void>) => {
    await fn();
  },
}));
jest.mock("../lib/email", () => ({ sendAlertIfSignificant: jest.fn().mockResolvedValue(0) }));
jest.mock("../lib/webhooks", () => ({ triggerWebhooks: jest.fn() }));
jest.mock("../lib/websocket", () => ({ broadcastScoreUpdate: jest.fn() }));
jest.mock("../lib/health", () => ({ recordCronRun: jest.fn() }));
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
import { markFailed } from "../lib/duplicate-detection";
import { logger } from "../lib/logger";

describe("scoreUpdateCron deferred accounting (#713)", () => {
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
  });

  it("queues a deferred project rather than submitting it on-chain", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(1);
    (updateImpactScore as jest.Mock).mockRejectedValue(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("records an error run when every project is deferred (total RPC outage)", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(3);
    (updateImpactScore as jest.Mock).mockRejectedValue(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    // Before the fix this was "success": successCount reached totalProcessed.
    expect(recordCronRun).toHaveBeenCalledWith("score-update", "error");
  });

  it("does not count a deferred project as a success", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(1);
    (updateImpactScore as jest.Mock).mockRejectedValue(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    // The distinguishing signal: an all-deferred batch is not reported as a
    // success. If deferrals were still counted as successes this would pass on
    // the old code too, so assert the inverse explicitly.
    expect(recordCronRun).not.toHaveBeenCalledWith("score-update", "success");
  });

  it("logs an outage alert when every project is deferred", async () => {
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    (getTotalProjects as jest.Mock).mockResolvedValue(2);
    (updateImpactScore as jest.Mock).mockRejectedValue(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    const alert = errorSpy.mock.calls.some((call) => String(call[0]).includes("ALERT"));
    expect(alert).toBe(true);
    errorSpy.mockRestore();
  });

  it("does not log a success summary for an all-deferred batch", async () => {
    // The all-deferred case is an outage, so it takes the error branch and must
    // not emit the "complete" summary that carries successCount.
    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined);
    (getTotalProjects as jest.Mock).mockResolvedValue(1);
    (updateImpactScore as jest.Mock).mockRejectedValue(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    const summary = infoSpy.mock.calls.find((call) =>
      String(call[0]).includes("hourly score update complete"),
    );
    expect(summary).toBeUndefined();
    infoSpy.mockRestore();
  });

  it("includes the deferred count in the batch summary log", async () => {
    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined);
    (getTotalProjects as jest.Mock).mockResolvedValue(2);
    (updateImpactScore as jest.Mock)
      .mockResolvedValueOnce("tx-1")
      .mockRejectedValueOnce(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    const summary = infoSpy.mock.calls.find((call) =>
      String(call[0]).includes("hourly score update complete"),
    );
    expect(summary).toBeDefined();
    expect(summary?.[1]).toMatchObject({ deferredCount: 1 });
    infoSpy.mockRestore();
  });

  // ── Mixed batches: the adjacent case that could regress carelessly ─────────

  it("treats a partially-deferred batch as success", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(2);
    (updateImpactScore as jest.Mock)
      .mockResolvedValueOnce("tx-1")
      .mockRejectedValueOnce(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    // Some projects reached the chain, so the run is not an outage.
    expect(recordCronRun).toHaveBeenCalledWith("score-update", "success");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("reports deferredCount in a mixed batch alongside the real success", async () => {
    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined);
    (getTotalProjects as jest.Mock).mockResolvedValue(2);
    (updateImpactScore as jest.Mock)
      .mockResolvedValueOnce("tx-1")
      .mockRejectedValueOnce(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    const summary = infoSpy.mock.calls.find((call) =>
      String(call[0]).includes("hourly score update complete"),
    );
    expect(summary?.[1]).toMatchObject({ successCount: 1, deferredCount: 1, failureCount: 0 });
    infoSpy.mockRestore();
  });

  it("still reports an error when every project genuinely fails", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(2);
    (updateImpactScore as jest.Mock).mockRejectedValue(new Error("contract reverted"));

    await runHourlyScoreUpdate();

    expect(recordCronRun).toHaveBeenCalledWith("score-update", "error");
  });

  // A genuine contract failure and a transport outage are different incidents
  // and must not be reported with the same message, or an operator cannot tell
  // a bad contract from a dead RPC. Kept as two tests rather than two runs in
  // one test, because scoreService holds module-level idempotency state that
  // only `beforeEach` clears.
  it("alerts about total failure in terms of failure", async () => {
    const alerts = await captureAlerts(new Error("contract reverted"));

    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.join(" ")).toMatch(/projects failed/);
    expect(alerts.join(" ")).not.toMatch(/deferred/);
  });

  it("alerts about a total deferral in terms of deferral, not failure", async () => {
    const alerts = await captureAlerts(new RpcDegradedError("RPC is degraded"));

    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.join(" ")).toMatch(/deferred/);
    expect(alerts.join(" ")).not.toMatch(/projects failed/);
  });

  /**
   * Runs one single-project batch with `error` thrown by the registry and
   * returns any ALERT messages that were logged.
   */
  async function captureAlerts(error: Error): Promise<string[]> {
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      (getTotalProjects as jest.Mock).mockResolvedValue(1);
      (updateImpactScore as jest.Mock).mockRejectedValue(error);
      await runHourlyScoreUpdate();
      return errorSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("ALERT"));
    } finally {
      errorSpy.mockRestore();
    }
  }

  it("a deferred-only batch is not double-counted as both success and failure", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(2);
    (updateImpactScore as jest.Mock).mockRejectedValue(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    // totalProcessed must count each deferred project exactly once, otherwise
    // allFailed and allDeferred could both evaluate true.
    expect(markFailed).not.toHaveBeenCalled();
    expect(recordCronRun).toHaveBeenCalledTimes(1);
  });
});
