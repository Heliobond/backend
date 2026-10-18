import express, { Express } from "express";
import request from "supertest";
import historyRouter from "../routes/history";
import { errorHandler } from "../middleware/errors";
import {
  computeTrend,
  recordScoreHistory,
  getHistory,
  clearHistoryStore,
  ScoreEntry,
  TrendAnalysis,
} from "../lib/history";

function makeEntry(projectId: number, cq: number, gi: number, timestamp: number): ScoreEntry {
  return {
    project_id: projectId,
    credit_quality: cq,
    green_impact: gi,
    timestamp,
  };
}

function makeSeries(
  scores: Array<[number, number] | number>,
  startTs = 1_000_000,
  stepMs = 60_000,
): ScoreEntry[] {
  return scores.map((val, idx) => {
    const cq = typeof val === "number" ? val / 2 : val[0];
    const gi = typeof val === "number" ? val / 2 : val[1];
    return makeEntry(1, cq, gi, startTs + idx * stepMs);
  });
}

describe("computeTrend intermediate samples & shape analysis", () => {
  beforeEach(() => {
    clearHistoryStore();
  });

  describe("boundaries, singletons, and threshold behavior", () => {
    it("handles empty array gracefully", () => {
      const res = computeTrend([]);
      expect(res).toEqual({
        trend: "stable",
        credit_quality_delta: 0,
        green_impact_delta: 0,
        sample_count: 0,
      });
    });

    it("handles single entry series gracefully", () => {
      const entries = makeSeries([75]);
      const res = computeTrend(entries);
      expect(res).toEqual({
        trend: "stable",
        credit_quality_delta: 0,
        green_impact_delta: 0,
        sample_count: 1,
      });
    });

    it.each([
      [50, 50, 0, "stable"],
      [50, 51.5, 1.5, "stable"],
      [50, 52.0, 2.0, "stable"],
      [50, 52.1, 2.1, "improving"],
      [50, 60, 10, "improving"],
      [50, 48.5, -1.5, "stable"],
      [50, 48.0, -2.0, "stable"],
      [50, 47.9, -2.1, "declining"],
      [50, 35, -15, "declining"],
    ])(
      "evaluates two-point series from %d to %d (delta %d) as %s",
      (from, to, _delta, expected) => {
        const entries = makeSeries([from, to]);
        const res = computeTrend(entries);
        expect(res.trend).toBe(expected);
        expect(res.sample_count).toBe(2);
        expect(res.credit_quality_delta + res.green_impact_delta).toBeCloseTo(to - from, 4);
      },
    );

    it("does not mutate the input array", () => {
      const entries = makeSeries([80, 20, 50]);
      const copy = [...entries];
      computeTrend(entries);
      expect(entries).toEqual(copy);
    });
  });

  describe("monotonic score progressions across various window lengths", () => {
    const increasingScenarios = [
      { name: "3-point simple", values: [50, 60, 70] },
      { name: "4-point small step", values: [40, 45, 50, 55] },
      { name: "5-point linear", values: [10, 20, 30, 40, 50] },
      { name: "6-point accelerating", values: [20, 22, 26, 33, 45, 60] },
      { name: "7-point decelerating", values: [20, 35, 47, 54, 58, 62, 65] },
      { name: "10-point gentle climb", values: [50, 52, 54, 56, 58, 60, 62, 64, 66, 68] },
      { name: "15-point steady climb", values: Array.from({ length: 15 }, (_, i) => 30 + i * 2) },
      {
        name: "25-point fine resolution",
        values: Array.from({ length: 25 }, (_, i) => 40 + i * 1.5),
      },
      { name: "50-point large series", values: Array.from({ length: 50 }, (_, i) => 20 + i * 1.2) },
      {
        name: "100-point stress series",
        values: Array.from({ length: 100 }, (_, i) => 10 + i * 0.8),
      },
    ];

    it.each(increasingScenarios)("identifies monotonic climb: $name", ({ values }) => {
      const entries = makeSeries(values);
      const res = computeTrend(entries);
      expect(res.trend).toBe("improving");
      expect(res.sample_count).toBe(values.length);
      expect(res.credit_quality_delta + res.green_impact_delta).toBeGreaterThan(0);
    });

    const decreasingScenarios = [
      { name: "3-point simple drop", values: [70, 60, 50] },
      { name: "4-point small step drop", values: [55, 50, 45, 40] },
      { name: "5-point linear drop", values: [50, 40, 30, 20, 10] },
      { name: "6-point accelerating drop", values: [60, 45, 33, 26, 22, 20] },
      { name: "7-point decelerating drop", values: [65, 62, 58, 54, 47, 35, 20] },
      { name: "10-point gentle slide", values: [68, 66, 64, 62, 60, 58, 56, 54, 52, 50] },
      { name: "15-point steady decline", values: Array.from({ length: 15 }, (_, i) => 60 - i * 2) },
      { name: "25-point fine decline", values: Array.from({ length: 25 }, (_, i) => 80 - i * 1.5) },
      {
        name: "50-point large decline",
        values: Array.from({ length: 50 }, (_, i) => 90 - i * 1.2),
      },
      {
        name: "100-point stress decline",
        values: Array.from({ length: 100 }, (_, i) => 95 - i * 0.8),
      },
    ];

    it.each(decreasingScenarios)("identifies monotonic decline: $name", ({ values }) => {
      const entries = makeSeries(values);
      const res = computeTrend(entries);
      expect(res.trend).toBe("declining");
      expect(res.sample_count).toBe(values.length);
      expect(res.credit_quality_delta + res.green_impact_delta).toBeLessThan(0);
    });
  });

  describe("rise-then-collapse pattern detection", () => {
    const riseThenCollapseScenarios = [
      { name: "3-point symmetric peak", values: [50, 90, 50] },
      { name: "3-point peak with slight net drop", values: [50, 85, 48] },
      { name: "3-point peak with slight net rise", values: [50, 85, 51] },
      { name: "4-point plateau and drop", values: [50, 80, 80, 50] },
      { name: "5-point classic hill", values: [50, 70, 90, 70, 50] },
      { name: "5-point early surge and slow bleed", values: [50, 95, 75, 60, 50] },
      { name: "5-point slow climb and sharp dump", values: [50, 60, 75, 95, 50] },
      { name: "7-point bell curve", values: [40, 55, 75, 90, 75, 55, 40] },
      {
        name: "9-point protracted rise and abrupt crash",
        values: [40, 48, 56, 68, 80, 92, 60, 45, 40],
      },
      {
        name: "12-point surge collapse with return to baseline",
        values: [50, 55, 65, 78, 88, 92, 85, 72, 62, 54, 51, 50],
      },
    ];

    it.each(riseThenCollapseScenarios)(
      "does NOT report stable for rise-then-collapse: $name",
      ({ values }) => {
        const entries = makeSeries(values);
        const res = computeTrend(entries);
        expect(res.trend).not.toBe("stable");
        expect(res.trend).toBe("declining");
      },
    );
  });

  describe("drop-then-rebound pattern detection", () => {
    const dropThenReboundScenarios = [
      { name: "3-point symmetric trough", values: [50, 10, 50] },
      { name: "3-point trough with slight net gain", values: [50, 15, 52] },
      { name: "3-point trough with slight net drop", values: [50, 15, 49] },
      { name: "4-point bottom dwell and surge", values: [50, 20, 20, 50] },
      { name: "5-point classic V-rebound", values: [50, 30, 10, 30, 50] },
      { name: "5-point flash crash and quick recovery", values: [50, 10, 30, 45, 50] },
      { name: "7-point deep trough", values: [60, 45, 25, 10, 25, 45, 60] },
      {
        name: "9-point slow decline then strong recovery",
        values: [60, 52, 44, 32, 20, 10, 35, 50, 60],
      },
      {
        name: "12-point trough recovery returning to baseline",
        values: [50, 45, 35, 22, 12, 8, 15, 28, 38, 46, 49, 50],
      },
    ];

    it.each(dropThenReboundScenarios)(
      "does NOT report stable for drop-then-rebound: $name",
      ({ values }) => {
        const entries = makeSeries(values);
        const res = computeTrend(entries);
        expect(res.trend).not.toBe("stable");
        expect(res.trend).toBe("improving");
      },
    );
  });

  describe("oscillating series and volatility handling", () => {
    const oscillatingScenarios = [
      { name: "4-point oscillation ending high", values: [50, 80, 40, 80], expected: "improving" },
      { name: "4-point oscillation ending low", values: [50, 80, 40, 35], expected: "declining" },
      { name: "5-point zigzag ending low", values: [50, 80, 40, 80, 40], expected: "declining" },
      { name: "5-point zigzag ending high", values: [50, 30, 70, 30, 70], expected: "improving" },
      {
        name: "6-point volatile ending high",
        values: [50, 75, 45, 80, 40, 78],
        expected: "improving",
      },
      {
        name: "6-point volatile ending low",
        values: [50, 75, 45, 80, 40, 35],
        expected: "declining",
      },
      {
        name: "8-point oscillating with upward drift",
        values: [40, 60, 45, 65, 50, 70, 55, 75],
        expected: "improving",
      },
      {
        name: "8-point oscillating with downward drift",
        values: [75, 55, 70, 50, 65, 45, 60, 40],
        expected: "declining",
      },
      {
        name: "10-point mean-reverting volatile ending low",
        values: [50, 70, 40, 65, 42, 68, 38, 62, 35, 30],
        expected: "declining",
      },
      {
        name: "10-point mean-reverting volatile ending high",
        values: [50, 30, 60, 35, 58, 32, 62, 38, 65, 70],
        expected: "improving",
      },
    ];

    it.each(oscillatingScenarios)(
      "evaluates oscillating series correctly: $name",
      ({ values, expected }) => {
        const entries = makeSeries(values);
        const res = computeTrend(entries);
        expect(res.trend).toBe(expected);
      },
    );
  });

  describe("flat and noise series without clear direction", () => {
    it.each([
      { name: "3-point flat 50s", values: [50, 50, 50] },
      { name: "5-point flat 75s", values: [75, 75, 75, 75, 75] },
      { name: "10-point flat 60s", values: Array(10).fill(60) },
      { name: "20-point flat 80s", values: Array(20).fill(80) },
      { name: "5-point tiny jitter (+/-0.2)", values: [50, 50.2, 49.9, 50.1, 50.0] },
      { name: "7-point tiny noise within 0.5", values: [60, 60.3, 59.8, 60.1, 59.7, 60.4, 60.0] },
      {
        name: "10-point tiny noise within 0.8",
        values: [70, 70.4, 69.6, 70.2, 69.7, 70.5, 69.8, 70.3, 69.5, 70.0],
      },
    ])("reports stable for non-trending series: $name", ({ values }) => {
      const entries = makeSeries(values);
      const res = computeTrend(entries);
      expect(res.trend).toBe("stable");
    });
  });

  describe("timestamp ordering invariance", () => {
    it("produces identical results regardless of input timestamp order", () => {
      const raw = [
        makeEntry(1, 20, 20, 1000),
        makeEntry(1, 35, 35, 2000),
        makeEntry(1, 45, 45, 3000),
        makeEntry(1, 35, 35, 4000),
        makeEntry(1, 20, 20, 5000),
      ];

      const inOrder = computeTrend(raw);
      const reversed = computeTrend([...raw].reverse());
      const shuffled = computeTrend([raw[2], raw[0], raw[4], raw[1], raw[3]]);

      expect(inOrder.trend).toBe("declining");
      expect(reversed.trend).toBe(inOrder.trend);
      expect(shuffled.trend).toBe(inOrder.trend);
      expect(reversed.credit_quality_delta).toBe(inOrder.credit_quality_delta);
      expect(shuffled.credit_quality_delta).toBe(inOrder.credit_quality_delta);
    });

    it("handles multiple samples with identical timestamps", () => {
      const entries = [
        makeEntry(1, 20, 20, 1000),
        makeEntry(1, 20, 20, 1000),
        makeEntry(1, 40, 40, 2000),
        makeEntry(1, 40, 40, 2000),
      ];
      const res = computeTrend(entries);
      expect(res.trend).toBe("improving");
      expect(res.sample_count).toBe(4);
    });
  });

  describe("component score dynamics (credit quality vs green impact)", () => {
    it.each([
      { name: "CQ jumps +20, GI flat", cq: [20, 30, 40], gi: [30, 30, 30], expected: "improving" },
      { name: "GI jumps +20, CQ flat", cq: [30, 30, 30], gi: [20, 30, 40], expected: "improving" },
      { name: "CQ drops -20, GI flat", cq: [40, 30, 20], gi: [30, 30, 30], expected: "declining" },
      { name: "GI drops -20, CQ flat", cq: [30, 30, 30], gi: [40, 30, 20], expected: "declining" },
      {
        name: "CQ climbs while GI drops by identical amount (net flat)",
        cq: [20, 25, 30],
        gi: [30, 25, 20],
        expected: "stable",
      },
      {
        name: "CQ peaks and crashes while GI remains constant",
        cq: [20, 50, 20],
        gi: [30, 30, 30],
        expected: "declining",
      },
      {
        name: "GI dips and rebounds while CQ remains constant",
        cq: [30, 30, 30],
        gi: [40, 10, 40],
        expected: "improving",
      },
    ])("analyzes component interplay: $name", ({ cq, gi, expected }) => {
      const entries = cq.map((c, i) => makeEntry(1, c, gi[i], 1000 + i * 1000));
      const res = computeTrend(entries);
      expect(res.trend).toBe(expected);
      expect(res.credit_quality_delta).toBe(cq[cq.length - 1] - cq[0]);
      expect(res.green_impact_delta).toBe(gi[gi.length - 1] - gi[0]);
    });
  });

  describe("history store recording and window retrieval integration", () => {
    it("integrates with recordScoreHistory and getHistory", () => {
      const projId = 42;
      const now = Date.now();
      recordScoreHistory(projId, 25, 25, now - 30_000);
      recordScoreHistory(projId, 45, 45, now - 20_000);
      recordScoreHistory(projId, 25, 25, now - 10_000);

      const entries = getHistory(projId);
      expect(entries).toHaveLength(3);

      const trend = computeTrend(entries);
      expect(trend.trend).toBe("declining");
      expect(trend.sample_count).toBe(3);
      expect(trend.credit_quality_delta).toBe(0);
      expect(trend.green_impact_delta).toBe(0);
    });

    it("evaluates trend across filtered time windows", () => {
      const projId = 99;
      const base = Date.now() - 60_000;
      // Step 1: Upward climb
      recordScoreHistory(projId, 20, 20, base + 1000);
      recordScoreHistory(projId, 30, 30, base + 2000);
      recordScoreHistory(projId, 40, 40, base + 3000);
      // Step 2: Plateau
      recordScoreHistory(projId, 40, 40, base + 4000);
      recordScoreHistory(projId, 40, 40, base + 5000);
      // Step 3: Crash
      recordScoreHistory(projId, 20, 20, base + 6000);

      // Window 1: climb
      const climbEntries = getHistory(projId, base + 1000, base + 3000);
      expect(computeTrend(climbEntries).trend).toBe("improving");

      // Window 2: entire series (climb + crash)
      const allEntries = getHistory(projId);
      expect(computeTrend(allEntries).trend).toBe("declining");

      // Window 3: plateau
      const plateauEntries = getHistory(projId, base + 3000, base + 5000);
      expect(computeTrend(plateauEntries).trend).toBe("stable");
    });
  });

  describe("parametric step size variations and synthetic slopes", () => {
    const stepSizes = [
      [0.2, "stable"],
      [0.5, "stable"],
      [0.7, "improving"],
      [1.0, "improving"],
      [1.5, "improving"],
      [2.0, "improving"],
      [3.0, "improving"],
      [5.0, "improving"],
      [10.0, "improving"],
    ] as const;

    it.each(stepSizes)(
      "evaluates positive step size +%d across 4 points as %s",
      (step, expected) => {
        const series = [50, 50 + step, 50 + step * 2, 50 + step * 3];
        const res = computeTrend(makeSeries(series));
        expect(res.trend).toBe(expected);
      },
    );

    const negStepSizes = [
      [0.2, "stable"],
      [0.5, "stable"],
      [0.7, "declining"],
      [1.0, "declining"],
      [1.5, "declining"],
      [2.0, "declining"],
      [3.0, "declining"],
      [5.0, "declining"],
      [10.0, "declining"],
    ] as const;

    it.each(negStepSizes)(
      "evaluates negative step size -%d across 4 points as %s",
      (step, expected) => {
        const series = [50, 50 - step, 50 - step * 2, 50 - step * 3];
        const res = computeTrend(makeSeries(series));
        expect(res.trend).toBe(expected);
      },
    );

    const peakHeights = [5, 10, 15, 25, 35, 50];
    it.each(peakHeights)(
      "flags rise of +%d then collapse back to baseline as declining",
      (peakHeight) => {
        const series = [50, 50 + peakHeight / 2, 50 + peakHeight, 50 + peakHeight / 2, 50];
        const res = computeTrend(makeSeries(series));
        expect(res.trend).toBe("declining");
      },
    );

    it.each(peakHeights)(
      "flags drop of -%d then rebound back to baseline as improving",
      (troughDepth) => {
        const series = [50, 50 - troughDepth / 2, 50 - troughDepth, 50 - troughDepth / 2, 50];
        const res = computeTrend(makeSeries(series));
        expect(res.trend).toBe("improving");
      },
    );

    const baselineOffsets = [-20, -10, 0, 10, 20, 30];
    it.each(baselineOffsets)("handles baseline level offset %d with flat series", (offset) => {
      const series = [50 + offset, 50 + offset, 50 + offset, 50 + offset];
      const res = computeTrend(makeSeries(series));
      expect(res.trend).toBe("stable");
    });
  });

  describe("route integration via HTTP", () => {
    function buildTestApp(): Express {
      const app = express();
      app.use(express.json());
      app.use("/api/projects/:id/history", historyRouter);
      app.use(errorHandler);
      return app;
    }

    it("returns 200 and declining for seeded rise-then-collapse via GET /trend", async () => {
      const app = buildTestApp();
      const projId = 777;
      const now = Date.now();
      recordScoreHistory(projId, 25, 25, now - 30_000);
      recordScoreHistory(projId, 45, 45, now - 20_000);
      recordScoreHistory(projId, 25, 25, now - 10_000);

      const res = await request(app).get(`/api/projects/${projId}/history/trend`).expect(200);
      expect(res.body.project_id).toBe(projId);
      expect(res.body.trend).toBe("declining");
      expect(res.body.sample_count).toBe(3);
    });

    it("returns 200 and improving for seeded drop-then-rebound via GET /trend", async () => {
      const app = buildTestApp();
      const projId = 888;
      const now = Date.now();
      recordScoreHistory(projId, 25, 25, now - 30_000);
      recordScoreHistory(projId, 10, 10, now - 20_000);
      recordScoreHistory(projId, 25, 25, now - 10_000);

      const res = await request(app).get(`/api/projects/${projId}/history/trend`).expect(200);
      expect(res.body.project_id).toBe(projId);
      expect(res.body.trend).toBe("improving");
      expect(res.body.sample_count).toBe(3);
    });

    it("returns 200 and stable for empty project history via GET /trend", async () => {
      const app = buildTestApp();
      const res = await request(app).get("/api/projects/9999/history/trend").expect(200);
      expect(res.body.trend).toBe("stable");
      expect(res.body.sample_count).toBe(0);
    });
  });
});
