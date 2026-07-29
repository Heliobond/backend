process.env.PROJECT_REGISTRY_CONTRACT_ID = "test-contract";

import * as iot from "../lib/iot";
import * as satelliteSources from "../lib/satellite-sources";
import * as scoring from "../lib/scoring";
import * as registry from "../lib/registry";
import { resetIdempotencyState, updateScoreForProject } from "../lib/scoreService";

describe("idempotency key behavior", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetIdempotencyState();

    jest.spyOn(iot, "getSolarData").mockReturnValue({ timestamp: Date.now(), forest_density_pct: 50, ndvi_score: 0.5 });
    jest.spyOn(satelliteSources, "fetchSatelliteWithFallback").mockResolvedValue({
      timestamp: Date.now(),
      forest_density_pct: 50,
      ndvi_score: 0.5,
    });
    jest.spyOn(scoring, "computeScores").mockReturnValue({ credit_quality: 10, green_impact: 20 });
    jest.spyOn(registry, "updateImpactScore").mockResolvedValue("tx-hash-1");
  });

  it("allows the first submission to succeed", async () => {
    const result = await updateScoreForProject(42);

    expect(result.status).toBe("success");
  });

  it("rejects a duplicate submission within the TTL", async () => {
    const first = await updateScoreForProject(42);
    const second = await updateScoreForProject(42);

    expect(first.status).toBe("success");
    expect(second.status).toBe("error");
    if (second.status === "error") {
      expect(second.error).toContain("duplicate");
    }
  });

  it("allows a submission after the TTL expires", async () => {
    jest.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_000 + 60_001);

    const first = await updateScoreForProject(42);
    const second = await updateScoreForProject(42);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
  });

  it("treats different project IDs as independent", async () => {
    const first = await updateScoreForProject(42);
    const second = await updateScoreForProject(43);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
  });
});
