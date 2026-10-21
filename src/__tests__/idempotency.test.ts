process.env.PROJECT_REGISTRY_CONTRACT_ID = "test-contract";

import * as iot from "../lib/iot";
import * as satelliteSources from "../lib/satellite-sources";
import * as scoring from "../lib/scoring";
import * as registry from "../lib/registry";
import { resetIdempotencyState, updateScoreForProject } from "../lib/scoreService";
import { checkIdempotency, getIdempotencyStoreSize } from "../lib/idempotency";
import { config } from "../config";
import { oracleScoreAge } from "../lib/prometheus";

describe("idempotency key behavior", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetIdempotencyState();

    jest.spyOn(iot, "getSolarData").mockReturnValue({
      timestamp: Date.now(),
      power_output_kw: 100,
      efficiency_pct: 0.85,
      max_power_kw: 120,
    });
    jest.spyOn(satelliteSources, "fetchSatelliteWithFallback").mockResolvedValue({
      timestamp: Date.now(),
      forest_density_pct: 50,
      ndvi_score: 0.5,
      source: "sentinel-2",
      dataSource: "live",
    });
    jest.spyOn(scoring, "computeScores").mockReturnValue({ credit_quality: 10, green_impact: 20 });
    jest.spyOn(registry, "updateImpactScore").mockResolvedValue("tx-hash-1");
  });

  it("allows the first submission to succeed", async () => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000);
    const result = await updateScoreForProject(42);

    expect(result.status).toBe("success");
    nowSpy.mockReturnValue(3_500);
    const metric = await oracleScoreAge.get();
    expect(metric.values.find(({ labels }) => labels.project_id === "42")?.value).toBe(2.5);
  });

  it("rejects a duplicate submission within the TTL", async () => {
    const first = await updateScoreForProject(42);
    const second = await updateScoreForProject(42);

    expect(first.status).toBe("success");
    expect(second.status).toBe("error");
    if (second.status === "error") {
      expect(second.error.toLowerCase()).toContain("duplicate");
    }
  });

  it("allows a submission in the next clock-hour (hourSeed rotates the key)", async () => {
    const nowSpy = jest.spyOn(Date, "now");

    // First invocation: fix time at hour 0
    nowSpy.mockReturnValue(0);
    const first = await updateScoreForProject(42);

    // Second invocation: advance to hour 1 (new hourSeed → new key)
    nowSpy.mockReturnValue(3_600_001);
    const second = await updateScoreForProject(42);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
  });

  describe("IDEMPOTENCY_TTL_MS expiry for a fixed key", () => {
    const key = "score:42:0";
    const ttl = config.IDEMPOTENCY_TTL_MS;
    const t0 = 1_000_000;

    it("still rejects the key exactly at the TTL boundary", () => {
      const nowSpy = jest.spyOn(Date, "now");

      nowSpy.mockReturnValue(t0);
      expect(checkIdempotency(key)).toEqual({ isDuplicate: false });

      nowSpy.mockReturnValue(t0 + ttl);
      expect(checkIdempotency(key)).toEqual({ isDuplicate: true, recordedAt: t0 });
    });

    it("accepts the same key once the TTL has elapsed", () => {
      const nowSpy = jest.spyOn(Date, "now");

      nowSpy.mockReturnValue(t0);
      expect(checkIdempotency(key).isDuplicate).toBe(false);

      nowSpy.mockReturnValue(t0 + ttl + 1);
      expect(checkIdempotency(key)).toEqual({ isDuplicate: false });

      // The re-recorded key is live again from the new timestamp.
      expect(checkIdempotency(key)).toEqual({ isDuplicate: true, recordedAt: t0 + ttl + 1 });
    });

    it("sweeps only expired keys and keeps live ones", () => {
      const nowSpy = jest.spyOn(Date, "now");
      const liveKey = "score:43:0";

      nowSpy.mockReturnValue(t0);
      checkIdempotency(key);
      nowSpy.mockReturnValue(t0 + Math.floor(ttl / 2));
      checkIdempotency(liveKey);
      expect(getIdempotencyStoreSize()).toBe(2);

      // `key` has expired; `liveKey` is still within its window.
      nowSpy.mockReturnValue(t0 + ttl + 1);
      expect(checkIdempotency(liveKey)).toEqual({
        isDuplicate: true,
        recordedAt: t0 + Math.floor(ttl / 2),
      });
      expect(getIdempotencyStoreSize()).toBe(1);
    });
  });

  it("releases idempotency key when submission defers due to RpcDegradedError (#830)", async () => {
    jest.spyOn(registry, "updateImpactScore").mockRejectedValueOnce(new registry.RpcDegradedError("degraded"));

    const deferredResult = await updateScoreForProject(42);
    expect(deferredResult.status).toBe("deferred");

    // Second call in the same hour should NOT be blocked as a duplicate because key was released
    const retryResult = await updateScoreForProject(42);
    expect(retryResult.status).toBe("success");
  });

  it("treats different project IDs as independent", async () => {
    const first = await updateScoreForProject(42);
    const second = await updateScoreForProject(43);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
  });
});
