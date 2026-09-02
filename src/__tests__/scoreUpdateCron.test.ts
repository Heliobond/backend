/**
 * Unit tests for src/lib/scoreUpdateCron.ts — the hourly score-update cron
 * job handler (extracted from src/index.ts for testability).
 *
 * Mocks every external dependency the flow touches: getTotalProjects,
 * getSolarData, fetchSatelliteWithFallback (satellite data), computeScores,
 * and updateImpactScore. scoreService.updateScoreForProject is left real so
 * the integration between these pieces is exercised.
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

jest.mock("../lib/iot", () => ({
  getSolarData: jest.fn(),
}));

jest.mock("../lib/satellite-sources", () => ({
  fetchSatelliteWithFallback: jest.fn(),
}));

jest.mock("../lib/scoring", () => ({
  computeScores: jest.fn(),
}));

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

jest.mock("../lib/tx-queue", () => ({
  enqueue: jest.fn(),
}));

jest.mock("../lib/email", () => ({
  sendAlertIfSignificant: jest.fn().mockResolvedValue(0),
}));

jest.mock("../lib/webhooks", () => ({
  triggerWebhooks: jest.fn(),
}));

jest.mock("../lib/websocket", () => ({
  broadcastScoreUpdate: jest.fn(),
}));

jest.mock("../lib/health", () => ({
  recordCronRun: jest.fn(),
}));

jest.mock("../config", () => ({
  config: {
    CRON_FAILURE_THRESHOLD: 0.5,
    IDEMPOTENCY_TTL_MS: 3_600_000,
  },
}));

import { runHourlyScoreUpdate } from "../lib/scoreUpdateCron";
import { getTotalProjects, updateImpactScore, RpcDegradedError } from "../lib/registry";
import { getSolarData } from "../lib/iot";
import { fetchSatelliteWithFallback } from "../lib/satellite-sources";
import { computeScores } from "../lib/scoring";
import { recordCronRun } from "../lib/health";
import { markFailed } from "../lib/duplicate-detection";
import { resetIdempotencyState } from "../lib/scoreService";
import { clearIdempotencyStore } from "../lib/idempotency";

describe("runHourlyScoreUpdate (cron job execution flow)", () => {
  beforeEach(() => {
    resetIdempotencyState();
    jest.clearAllMocks();
    clearIdempotencyStore(); // prevent key bleed between tests
    (getSolarData as jest.Mock).mockReturnValue({
      efficiency_pct: 85,
      power_output_kw: 500,
      max_power_kw: 1000,
    });
    (fetchSatelliteWithFallback as jest.Mock).mockResolvedValue({
      forest_density_pct: 60,
      ndvi_score: 0.6,
    });
    (computeScores as jest.Mock).mockReturnValue({
      credit_quality: 85,
      green_impact: 70,
    });
    (updateImpactScore as jest.Mock).mockResolvedValue("tx-hash");
  });

  it("calls getTotalProjects to determine which projects to process", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(0);

    await runHourlyScoreUpdate();

    expect(getTotalProjects).toHaveBeenCalledTimes(1);
  });

  it("processes each project returned by getTotalProjects", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(3);

    await runHourlyScoreUpdate();

    expect(updateImpactScore).toHaveBeenCalledTimes(3);
    expect(updateImpactScore).toHaveBeenNthCalledWith(1, 1, 85, 70, expect.any(String));
    expect(updateImpactScore).toHaveBeenNthCalledWith(2, 2, 85, 70, expect.any(String));
    expect(updateImpactScore).toHaveBeenNthCalledWith(3, 3, 85, 70, expect.any(String));
    expect(recordCronRun).toHaveBeenCalledWith("score-update", "success");
  });

  it("isolates a per-project failure without aborting the rest of the batch", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(3);
    (updateImpactScore as jest.Mock)
      .mockResolvedValueOnce("tx-1")
      .mockRejectedValueOnce(new Error("submit failed"))
      .mockResolvedValueOnce("tx-3");

    await runHourlyScoreUpdate();

    expect(updateImpactScore).toHaveBeenCalledTimes(3);
    expect(markFailed).toHaveBeenCalledWith(2);
    // Not all projects failed, so it records success (below failure threshold config)
    expect(recordCronRun).toHaveBeenCalledWith("score-update", "success");
  });

  it("records an error run when every project fails", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(2);
    (updateImpactScore as jest.Mock).mockRejectedValue(new Error("systemic failure"));

    await runHourlyScoreUpdate();

    expect(markFailed).toHaveBeenCalledTimes(2);
    expect(recordCronRun).toHaveBeenCalledWith("score-update", "error");
  });

  it("handles getTotalProjects failure without throwing, and records an error run", async () => {
    (getTotalProjects as jest.Mock).mockRejectedValue(new Error("RPC unreachable"));

    await expect(runHourlyScoreUpdate()).resolves.toBeUndefined();

    expect(updateImpactScore).not.toHaveBeenCalled();
    expect(recordCronRun).toHaveBeenCalledWith("score-update", "error");
  });

  it("defers (does not fail) a project when updateImpactScore rejects with RpcDegradedError", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(1);
    (updateImpactScore as jest.Mock).mockRejectedValue(new RpcDegradedError("RPC is degraded"));

    await runHourlyScoreUpdate();

    expect(markFailed).not.toHaveBeenCalled();
    expect(recordCronRun).toHaveBeenCalledWith("score-update", "success");
  });
});
