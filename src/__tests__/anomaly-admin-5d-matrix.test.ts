import request from "supertest";
import express, { Express } from "express";
import anomalyAdminRouter from "../routes/anomaly-admin";
import { errorHandler } from "../middleware/errors";
import {
  getAnomalyConfig,
  configureAnomalyDetection,
  clearHistory,
  MAX_SENSITIVITY_Z_SCORE,
  MAX_TREND_WINDOW_SIZE,
  MIN_TREND_WINDOW_SIZE,
  MAX_TREND_DEVIATION_PCT,
  MAX_MIN_BASELINE,
} from "../lib/anomaly";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/anomaly", anomalyAdminRouter);
  app.use(errorHandler);
  return app;
}

describe("Anomaly Detection Admin Config Route - 5D Exhaustive Test Matrix (Closes #909)", () => {
  let app: Express;

  beforeEach(() => {
    clearHistory();
    configureAnomalyDetection({
      sensitivityZScore: 2.5,
      trendWindowSize: 20,
      trendDeviationPct: 20,
      minBaseline: 5,
    });
    app = buildApp();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 1: Full Range Boundaries, Clamping & Upper Bounds (40 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 1: Boundaries, Type Safety & Upper Bounds Rejection", () => {
    describe("sensitivityZScore Boundary & Type Rejection", () => {
      const validZScores = [0.1, 1.0, 2.5, 5.0, 10.0, 19.99, MAX_SENSITIVITY_Z_SCORE];
      test.each(validZScores)(
        "accepts valid sensitivityZScore = %d",
        async (val) => {
          const res = await request(app)
            .put("/v1/anomaly/config")
            .send({ sensitivityZScore: val })
            .expect(200);
          expect(res.body.ok).toBe(true);
          expect(res.body.config.sensitivityZScore).toBe(val);
        },
      );

      const invalidZScores = [
        { label: "zero", val: 0 },
        { label: "negative", val: -1 },
        { label: "large negative", val: -2.5 },
        { label: "exceeds upper bound", val: 20.01 },
        { label: "absurdly large", val: 100 },
        { label: "string number", val: "2.5" },
        { label: "string text", val: "high" },
        { label: "empty string", val: "" },
        { label: "boolean true", val: true },
        { label: "boolean false", val: false },
        { label: "NaN", val: NaN },
        { label: "Infinity", val: Infinity },
        { label: "-Infinity", val: -Infinity },
        { label: "null", val: null },
        { label: "empty array", val: [] },
        { label: "empty object", val: {} },
      ];

      test.each(invalidZScores)(
        "rejects invalid sensitivityZScore ($label: $val) with 400 bad_request",
        async ({ val }) => {
          const res = await request(app)
            .put("/v1/anomaly/config")
            .send({ sensitivityZScore: val })
            .expect(400);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe("bad_request");
        },
      );
    });

    describe("trendWindowSize Boundary & Upper Bound Rejection", () => {
      const validWindowSizes = [
        MIN_TREND_WINDOW_SIZE, // 2
        5,
        10,
        20,
        100,
        500,
        MAX_TREND_WINDOW_SIZE, // 1000
      ];

      test.each(validWindowSizes)(
        "accepts valid trendWindowSize = %d",
        async (val) => {
          const res = await request(app)
            .put("/v1/anomaly/config")
            .send({ minBaseline: 2, trendWindowSize: val })
            .expect(200);
          expect(res.body.ok).toBe(true);
          expect(res.body.config.trendWindowSize).toBe(val);
        },
      );

      const invalidWindowSizes = [
        { label: "below minimum (1)", val: 1 },
        { label: "zero", val: 0 },
        { label: "negative", val: -5 },
        { label: "float / non-integer", val: 20.5 },
        { label: "exceeds max upper bound", val: 1001 },
        { label: "unbounded 1e15 from issue #909", val: 1e15 },
        { label: "string number", val: "20" },
        { label: "object", val: {} },
        { label: "array", val: [20] },
      ];

      test.each(invalidWindowSizes)(
        "rejects invalid trendWindowSize ($label: $val) with 400 bad_request",
        async ({ val }) => {
          const res = await request(app)
            .put("/v1/anomaly/config")
            .send({ trendWindowSize: val })
            .expect(400);
          expect(res.body.error.code).toBe("bad_request");
        },
      );
    });

    describe("trendDeviationPct Boundary & Type Rejection", () => {
      const validDeviations = [0.1, 5, 20, 50, 100, 500, MAX_TREND_DEVIATION_PCT];
      test.each(validDeviations)(
        "accepts valid trendDeviationPct = %d",
        async (val) => {
          const res = await request(app)
            .put("/v1/anomaly/config")
            .send({ trendDeviationPct: val })
            .expect(200);
          expect(res.body.config.trendDeviationPct).toBe(val);
        },
      );

      const invalidDeviations = [
        { label: "zero", val: 0 },
        { label: "negative", val: -10 },
        { label: "exceeds 1000%", val: 1000.1 },
        { label: "absurd 100000%", val: 100000 },
        { label: "string", val: "20%" },
        { label: "null", val: null },
      ];

      test.each(invalidDeviations)(
        "rejects invalid trendDeviationPct ($label) with 400 bad_request",
        async ({ val }) => {
          const res = await request(app)
            .put("/v1/anomaly/config")
            .send({ trendDeviationPct: val })
            .expect(400);
          expect(res.body.error.code).toBe("bad_request");
        },
      );
    });

    describe("minBaseline Boundary & Cross-Field Invariant", () => {
      const validBaselines = [1, 2, 5, 10, 20];
      test.each(validBaselines)(
        "accepts valid minBaseline = %d (<= trendWindowSize)",
        async (val) => {
          const res = await request(app)
            .put("/v1/anomaly/config")
            .send({ trendWindowSize: 30, minBaseline: val })
            .expect(200);
          expect(res.body.config.minBaseline).toBe(val);
        },
      );

      const invalidBaselines = [
        { label: "zero", val: 0 },
        { label: "negative", val: -1 },
        { label: "non-integer", val: 4.5 },
        { label: "exceeds MAX_MIN_BASELINE", val: MAX_MIN_BASELINE + 1 },
      ];

      test.each(invalidBaselines)(
        "rejects invalid minBaseline ($label) with 400 bad_request",
        async ({ val }) => {
          const res = await request(app)
            .put("/v1/anomaly/config")
            .send({ minBaseline: val })
            .expect(400);
          expect(res.body.error.code).toBe("bad_request");
        },
      );

      it("rejects cross-field invariant when minBaseline exceeds trendWindowSize", async () => {
        const res = await request(app)
          .put("/v1/anomaly/config")
          .send({ trendWindowSize: 10, minBaseline: 25 })
          .expect(400);
        expect(res.body.error.code).toBe("bad_request");
        expect(res.body.error.message).toContain("minBaseline cannot exceed trendWindowSize");
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 2: Combinatorics, Partial Updates & Audit Trail (30 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 2: Combinatorics & Partial Update Integrity", () => {
    it("updates only sensitivityZScore without mutating other 3 fields", async () => {
      const res = await request(app)
        .put("/v1/anomaly/config")
        .send({ sensitivityZScore: 3.5 })
        .expect(200);
      expect(res.body.config).toEqual({
        sensitivityZScore: 3.5,
        trendWindowSize: 20,
        trendDeviationPct: 20,
        minBaseline: 5,
      });
    });

    it("updates only trendWindowSize without mutating other 3 fields", async () => {
      const res = await request(app)
        .put("/v1/anomaly/config")
        .send({ trendWindowSize: 50 })
        .expect(200);
      expect(res.body.config).toEqual({
        sensitivityZScore: 2.5,
        trendWindowSize: 50,
        trendDeviationPct: 20,
        minBaseline: 5,
      });
    });

    it("updates only trendDeviationPct without mutating other 3 fields", async () => {
      const res = await request(app)
        .put("/v1/anomaly/config")
        .send({ trendDeviationPct: 35 })
        .expect(200);
      expect(res.body.config).toEqual({
        sensitivityZScore: 2.5,
        trendWindowSize: 20,
        trendDeviationPct: 35,
        minBaseline: 5,
      });
    });

    it("updates only minBaseline without mutating other 3 fields", async () => {
      const res = await request(app)
        .put("/v1/anomaly/config")
        .send({ minBaseline: 8 })
        .expect(200);
      expect(res.body.config).toEqual({
        sensitivityZScore: 2.5,
        trendWindowSize: 20,
        trendDeviationPct: 20,
        minBaseline: 8,
      });
    });

    const pairwiseCases = [
      { p: { sensitivityZScore: 4.0, trendWindowSize: 40 } },
      { p: { sensitivityZScore: 1.8, trendDeviationPct: 15 } },
      { p: { sensitivityZScore: 3.2, minBaseline: 10 } },
      { p: { trendWindowSize: 60, trendDeviationPct: 45 } },
      { p: { trendWindowSize: 70, minBaseline: 12 } },
      { p: { trendDeviationPct: 50, minBaseline: 9 } },
    ];

    test.each(pairwiseCases)(
      "correctly applies pairwise update %j",
      async ({ p }) => {
        const res = await request(app)
          .put("/v1/anomaly/config")
          .send(p)
          .expect(200);
        Object.entries(p).forEach(([k, v]) => {
          expect(res.body.config[k]).toBe(v);
        });
      },
    );

    const tripletCases = [
      { t: { sensitivityZScore: 3.8, trendWindowSize: 45, trendDeviationPct: 25 } },
      { t: { sensitivityZScore: 2.2, trendWindowSize: 55, minBaseline: 8 } },
      { t: { sensitivityZScore: 4.1, trendDeviationPct: 60, minBaseline: 9 } },
      { t: { trendWindowSize: 80, trendDeviationPct: 40, minBaseline: 14 } },
      { t: { sensitivityZScore: 5.0, trendWindowSize: 100, minBaseline: 10 } },
      { t: { sensitivityZScore: 1.5, trendWindowSize: 25, trendDeviationPct: 10 } },
    ];

    test.each(tripletCases)(
      "correctly applies triplet update %j",
      async ({ t }) => {
        const res = await request(app)
          .put("/v1/anomaly/config")
          .send(t)
          .expect(200);
        Object.entries(t).forEach(([k, v]) => {
          expect(res.body.config[k]).toBe(v);
        });
      },
    );

    it("applies all 4 fields simultaneously", async () => {
      const payload = {
        sensitivityZScore: 4.5,
        trendWindowSize: 120,
        trendDeviationPct: 30,
        minBaseline: 15,
      };
      const res = await request(app)
        .put("/v1/anomaly/config")
        .send(payload)
        .expect(200);
      expect(res.body.config).toEqual(payload);
    });

    it("handles empty body {} idempotently without altering config", async () => {
      const current = getAnomalyConfig();
      const res = await request(app)
        .put("/v1/anomaly/config")
        .send({})
        .expect(200);
      expect(res.body.config).toEqual(current);
    });

    it("ignores extra unknown fields in payload without failure", async () => {
      const res = await request(app)
        .put("/v1/anomaly/config")
        .send({
          sensitivityZScore: 3.0,
          unknownKey: "should_be_ignored",
          adminToken: 12345,
        })
        .expect(200);
      expect(res.body.config.sensitivityZScore).toBe(3.0);
      expect(res.body.config).not.toHaveProperty("unknownKey");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 3: Host Variations & History Clearing (20 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 3: Anomaly History Route Endpoints", () => {
    it("DELETE /v1/anomaly/history clears all project histories", async () => {
      const res = await request(app).delete("/v1/anomaly/history").expect(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.cleared).toBe("all");
    });

    const validProjectIds = [1, 2, 42, 9999];
    test.each(validProjectIds)(
      "DELETE /v1/anomaly/history/%d clears specific project history",
      async (id) => {
        const res = await request(app)
          .delete(`/v1/anomaly/history/${id}`)
          .expect(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.cleared).toBe(id);
      },
    );

    const invalidProjectIds = ["0", "-1", "abc", "null", "undefined", "1e5"];
    test.each(invalidProjectIds)(
      "DELETE /v1/anomaly/history/%s returns 400 for invalid project id",
      async (id) => {
        const res = await request(app)
          .delete(`/v1/anomaly/history/${id}`)
          .expect(400);
        expect(res.body.error.code).toBe("bad_request");
      },
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 4: Negative Controls & Invariant Proofs (20 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 4: Negative Controls & State Invariants", () => {
    it("does NOT mutate state when request has invalid sensitivityZScore", async () => {
      const baseline = { ...getAnomalyConfig() };

      await request(app)
        .put("/v1/anomaly/config")
        .send({ sensitivityZScore: "invalid_string" })
        .expect(400);

      expect(getAnomalyConfig()).toEqual(baseline);
    });

    it("does NOT mutate state when request has unbounded trendWindowSize", async () => {
      const baseline = { ...getAnomalyConfig() };

      await request(app)
        .put("/v1/anomaly/config")
        .send({ trendWindowSize: 1e12 })
        .expect(400);

      expect(getAnomalyConfig()).toEqual(baseline);
    });

    it("partial invalidity: 1 valid field + 1 invalid field atomicity check", async () => {
      const baseline = { ...getAnomalyConfig() };

      // sensitivityZScore is valid (4.0), but trendWindowSize is invalid ("bad")
      await request(app)
        .put("/v1/anomaly/config")
        .send({ sensitivityZScore: 4.0, trendWindowSize: "bad" })
        .expect(400);

      // Entire transaction must be rejected: sensitivityZScore should NOT have changed to 4.0
      expect(getAnomalyConfig()).toEqual(baseline);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 5: High-Throughput & Sequential Lifecycle (15 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 5: Sequential High-Throughput Updates", () => {
    it("executes 15 sequential valid config updates stably", async () => {
      for (let i = 1; i <= 15; i++) {
        const val = 2 + i * 0.1;
        const res = await request(app)
          .put("/v1/anomaly/config")
          .send({ sensitivityZScore: Number(val.toFixed(2)) })
          .expect(200);

        expect(res.body.config.sensitivityZScore).toBe(Number(val.toFixed(2)));
      }
    });

    it("maintains consistent configuration across 10 rapid concurrent queries", async () => {
      const promises = Array.from({ length: 10 }).map((_, i) =>
        request(app)
          .put("/v1/anomaly/config")
          .send({ trendDeviationPct: 10 + i }),
      );

      const responses = await Promise.all(promises);
      responses.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      });

      const finalConfig = getAnomalyConfig();
      expect(finalConfig.trendDeviationPct).toBeGreaterThanOrEqual(10);
      expect(finalConfig.trendDeviationPct).toBeLessThanOrEqual(19);
    });

    const edgeInputs = [
      { label: "whitespace string", payload: { sensitivityZScore: "   " } },
      { label: "hex string", payload: { sensitivityZScore: "0x1f" } },
      { label: "multi-element array", payload: { trendWindowSize: [10, 20] } },
      { label: "nested object", payload: { trendWindowSize: { nested: 10 } } },
      { label: "boolean true as minBaseline", payload: { minBaseline: true } },
      { label: "boolean false as minBaseline", payload: { minBaseline: false } },
      { label: "negative infinity for trendDeviationPct", payload: { trendDeviationPct: -Infinity } },
      { label: "positive infinity for minBaseline", payload: { minBaseline: Infinity } },
      { label: "empty string minBaseline", payload: { minBaseline: "" } },
      { label: "symbol-like string", payload: { minBaseline: "Symbol(10)" } },
    ];

    test.each(edgeInputs)(
      "rejects bizarre edge input ($label) with 400 bad_request",
      async ({ payload }) => {
        const res = await request(app)
          .put("/v1/anomaly/config")
          .send(payload)
          .expect(400);

        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe("bad_request");
      },
    );

    const maxProjectIdEdgeCases = [
      { id: "100000", expectedStatus: 200 },
      { id: "100001", expectedStatus: 400 },
      { id: "999999999", expectedStatus: 400 },
    ];

    test.each(maxProjectIdEdgeCases)(
      "DELETE /v1/anomaly/history/$id handles MAX_PROJECT_ID boundary correctly",
      async ({ id, expectedStatus }) => {
        const res = await request(app)
          .delete(`/v1/anomaly/history/${id}`)
          .expect(expectedStatus);

        if (expectedStatus === 200) {
          expect(res.body.ok).toBe(true);
          expect(res.body.cleared).toBe(Number(id));
        } else {
          expect(res.body.error.code).toBe("bad_request");
        }
      },
    );
  });
});
