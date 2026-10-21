/**
 * Regression tests for #833 — the batch score-update route previously:
 *   1. called `updateImpactScore` with no idempotency key, so a batch
 *      overlapping the hourly cron in the same clock-hour double-submitted
 *      `update_impact_score` on-chain, and
 *   2. on RpcDegradedError, fired `recordScoreHistory` and `triggerWebhooks`
 *      with `tx_hash: "deferred"` (a transaction that never happened) and
 *      skipped the retry queue entirely, so the deferred update was lost.
 *
 * These tests pin the fixed behavior: deferred results enqueue only, no
 * history or webhook; duplicate submissions skip updateImpactScore.
 *
 * Note: the pre-existing `batch.spec.ts` in this directory is picked up by
 * no Jest run on the current `testMatch` (`**` + `/__tests__/**` + `/*.test.ts`),
 * so this file is intentionally named `.test.ts`.
 */

import request from "supertest";
import type { Response } from "supertest";
import express, { Express } from "express";
import batchRouter from "../routes/batch";
import { errorHandler } from "../middleware/errors";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import * as history from "../lib/history";
import * as webhooks from "../lib/webhooks";
import * as txQueue from "../lib/tx-queue";
import { clearIdempotencyStore } from "../lib/idempotency";

jest.mock("../config", () => ({
  config: { PROJECT_REGISTRY_CONTRACT_ID: "dummy-registry-id", IDEMPOTENCY_TTL_MS: 3_600_000 },
}));
jest.mock("../lib/registry", () => {
  class RpcDegradedError extends Error {
    constructor(message?: string) {
      super(message ?? "RPC is degraded");
      this.name = "RpcDegradedError";
    }
  }
  return {
    updateImpactScore: jest.fn(),
    getTotalProjects: jest.fn(),
    RpcDegradedError,
  };
});
jest.mock("../routes/iot");
jest.mock("../lib/scoring");
jest.mock("../lib/history", () => ({ recordScoreHistory: jest.fn() }));
jest.mock("../lib/webhooks", () => ({ triggerWebhooks: jest.fn() }));
jest.mock("../lib/tx-queue", () => ({ enqueue: jest.fn() }));

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/batch", batchRouter);
  app.use(errorHandler);
  return app;
}

async function waitForBatchDone(app: Express, batchId: string): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const res = await request(app).get(`/api/admin/batch/${batchId}/status`);
    if (res.status === 200 && (res.body.status === "completed" || res.body.status === "failed")) {
      return res;
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`batch ${batchId} did not finish in time`);
}

describe("batch score-update deferred + idempotency (#833)", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    clearIdempotencyStore();

    (iot.getSolarData as jest.Mock).mockReturnValue({
      efficiency_pct: 80,
      power_output_kw: 400,
      max_power_kw: 1000,
    });
    (iot.getSatelliteData as jest.Mock).mockReturnValue({
      forest_density_pct: 50,
      ndvi_score: 0.5,
    });
    (scoring.computeScores as jest.Mock).mockReturnValue({ credit_quality: 80, green_impact: 65 });
    (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-batch");
    (registry.getTotalProjects as jest.Mock).mockResolvedValue(3);
  });

  it("deferred batch update is enqueued, with no history or webhook fired", async () => {
    const RpcDegradedError = (
      registry as unknown as { RpcDegradedError: new (msg?: string) => Error }
    ).RpcDegradedError;
    (registry.updateImpactScore as jest.Mock).mockRejectedValueOnce(
      new RpcDegradedError("RPC is degraded"),
    );

    const create = await request(app)
      .post("/api/admin/batch/score-update")
      .send({ project_ids: [42] })
      .expect(202);

    const status = await waitForBatchDone(app, create.body.batch_id);
    const result = (status.body.results as Array<{ project_id: number; tx_hash: string }>)[0];
    expect(result).toMatchObject({ project_id: 42, tx_hash: "deferred" });

    // Deferred scores must land on the shared retry queue so runTxQueueRetry
    // picks them up on the next tick.
    expect(txQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(txQueue.enqueue).toHaveBeenCalledWith(42, 80, 65, "RPC degraded");

    // No history row and no webhook for a transaction that never happened.
    expect(history.recordScoreHistory).not.toHaveBeenCalled();
    expect(webhooks.triggerWebhooks).not.toHaveBeenCalled();
  });

  it("rejects a second batch for the same project within the same clock-hour", async () => {
    // First batch wins the hourly idempotency key and submits on-chain.
    const first = await request(app)
      .post("/api/admin/batch/score-update")
      .send({ project_ids: [7] })
      .expect(202);
    await waitForBatchDone(app, first.body.batch_id);
    expect(registry.updateImpactScore).toHaveBeenCalledTimes(1);

    // A second batch in the same hour must short-circuit before reaching
    // updateImpactScore and emit no second on-chain call.
    const second = await request(app)
      .post("/api/admin/batch/score-update")
      .send({ project_ids: [7] })
      .expect(202);
    const status = await waitForBatchDone(app, second.body.batch_id);

    expect(registry.updateImpactScore).toHaveBeenCalledTimes(1);
    const skipped = (status.body.results as Array<{ skipped?: boolean; skip_reason?: string }>)[0];
    expect(skipped.skipped).toBe(true);
    expect(skipped.skip_reason).toContain("duplicate submission rejected");
  });
});
