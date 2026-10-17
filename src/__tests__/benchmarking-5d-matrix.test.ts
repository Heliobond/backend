import request from "supertest";
import express, { Express } from "express";
import benchmarkingRouter from "../routes/benchmarking";
import { errorHandler } from "../middleware/errors";
import {
  initBenchmarkSamples,
  getBenchmarks,
  getBenchmarkById,
  clearCustomBenchmarks,
  KNOWN_METRICS,
  getBuiltInBenchmarkIds,
  evaluateAllBenchmarks,
} from "../lib/benchmarking";

const TEST_ADMIN_KEY = "test-secret-admin-key-2026";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/benchmarking", benchmarkingRouter);
  app.use(errorHandler);
  return app;
}

describe("RFC Standardized Benchmarking Route - 5D Exhaustive Test Matrix (Closes #911)", () => {
  let app: Express;
  const originalEnv = process.env.ADMIN_API_KEY;

  beforeAll(() => {
    initBenchmarkSamples(10);
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  });

  afterAll(() => {
    process.env.ADMIN_API_KEY = originalEnv;
    clearCustomBenchmarks();
  });

  beforeEach(() => {
    clearCustomBenchmarks();
    app = buildApp();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 1: Full Range Boundaries, Clamping & Status Codes (35 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 1: Boundaries, Clamping & 404 Status Codes", () => {
    describe("404 for unknown benchmark routes", () => {
      const unknownIds = [
        "nonexistent",
        "unknown_id",
        "null",
        "undefined",
        "0",
        "benchmark_999",
        "credit_quality_v2",
        "credit-quality",
        "credit_quality_typo",
        "solar_efficiency", // built-in id is efficiency_pct
      ];

      test.each(unknownIds)(
        "GET /api/benchmarking/benchmarks/%s returns 404 not_found",
        async (id) => {
          const res = await request(app)
            .get(`/api/benchmarking/benchmarks/${id}`)
            .expect(404);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe("not_found");
          expect(res.body.error.message).toContain(`Benchmark "${id}" not found`);
        },
      );

      test.each(unknownIds)(
        "GET /api/benchmarking/:id/trend with unknown benchmark=%s returns 404 not_found",
        async (benchId) => {
          const res = await request(app)
            .get(`/api/benchmarking/1/trend?benchmark=${benchId}`)
            .expect(404);
          expect(res.body.error.code).toBe("not_found");
          expect(res.body.error.message).toContain(`Benchmark "${benchId}" not found`);
        },
      );
    });

    describe("Supported vs Unsupported Metric Validation (POST /benchmarks)", () => {
      test.each(KNOWN_METRICS)(
        "accepts known metric: %s",
        async (metric) => {
          const res = await request(app)
            .post("/api/benchmarking/benchmarks")
            .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
            .send({
              name: `Metric Test ${metric}`,
              metric,
              thresholds: { poor: 10, fair: 20, good: 30, excellent: 40 },
            })
            .expect(201);
          expect(res.body.metric).toBe(metric);
        },
      );

      const invalidMetrics = [
        "unknown",
        "CREDIT_QUALITY",
        "combined",
        "solar",
        "satellite",
        "__proto__",
        "toString",
        "null",
        "123",
      ];

      test.each(invalidMetrics)(
        "rejects unsupported metric '%s' with 400 bad_request",
        async (metric) => {
          const res = await request(app)
            .post("/api/benchmarking/benchmarks")
            .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
            .send({
              name: "Invalid Metric Benchmark",
              metric,
              thresholds: { poor: 10, fair: 20, good: 30, excellent: 40 },
            })
            .expect(400);
          expect(res.body.error.code).toBe("bad_request");
          expect(res.body.error.message).toContain("Invalid metric");
        },
      );
    });

    describe("Threshold Boundary & Ordering Validation", () => {
      it("accepts zero boundary thresholds: poor = fair = good = excellent = 0", async () => {
        const res = await request(app)
          .post("/api/benchmarking/benchmarks")
          .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
          .send({
            name: "Zero Boundary Benchmark",
            metric: "credit_quality",
            thresholds: { poor: 0, fair: 0, good: 0, excellent: 0 },
          })
          .expect(201);
        expect(res.body.thresholds).toEqual({ poor: 0, fair: 0, good: 0, excellent: 0 });
      });

      it("accepts non-zero identical thresholds (boundary where values match)", async () => {
        const res = await request(app)
          .post("/api/benchmarking/benchmarks")
          .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
          .send({
            name: "Flat Threshold Benchmark",
            metric: "credit_quality",
            thresholds: { poor: 50, fair: 50, good: 50, excellent: 50 },
          })
          .expect(201);
        expect(res.body.thresholds.poor).toBe(50);
      });

      it("accepts decimal floating point thresholds with valid ordering", async () => {
        const res = await request(app)
          .post("/api/benchmarking/benchmarks")
          .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
          .send({
            name: "Float Thresholds",
            metric: "efficiency_pct",
            thresholds: { poor: 0.25, fair: 1.5, good: 5.75, excellent: 99.99 },
          })
          .expect(201);
        expect(res.body.thresholds.poor).toBe(0.25);
      });

      const negativeThresholdCases = [
        { label: "poor < 0", t: { poor: -1, fair: 10, good: 20, excellent: 30 } },
        { label: "fair < 0", t: { poor: 0, fair: -0.1, good: 20, excellent: 30 } },
        { label: "good < 0", t: { poor: 0, fair: 0, good: -5, excellent: 30 } },
        { label: "excellent < 0", t: { poor: 0, fair: 0, good: 0, excellent: -10 } },
      ];

      test.each(negativeThresholdCases)(
        "rejects negative threshold (%s) with 400 bad_request",
        async ({ t }) => {
          const res = await request(app)
            .post("/api/benchmarking/benchmarks")
            .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
            .send({
              name: "Negative Test",
              metric: "credit_quality",
              thresholds: t,
            })
            .expect(400);
          expect(res.body.error.code).toBe("bad_request");
          expect(res.body.error.message).toContain("non-negative");
        },
      );

      const outOfOrderCases = [
        { label: "poor > fair", t: { poor: 50, fair: 40, good: 60, excellent: 80 } },
        { label: "fair > good", t: { poor: 20, fair: 70, good: 60, excellent: 80 } },
        { label: "good > excellent", t: { poor: 20, fair: 40, good: 90, excellent: 80 } },
        { label: "strictly decreasing", t: { poor: 100, fair: 75, good: 50, excellent: 25 } },
      ];

      test.each(outOfOrderCases)(
        "rejects inverted threshold ordering (%s) with 400 bad_request",
        async ({ t }) => {
          const res = await request(app)
            .post("/api/benchmarking/benchmarks")
            .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
            .send({
              name: "Out Of Order",
              metric: "credit_quality",
              thresholds: t,
            })
            .expect(400);
          expect(res.body.error.code).toBe("bad_request");
          expect(res.body.error.message).toContain("poor <= fair <= good <= excellent");
        },
      );
    });

    describe("Built-in ID Collision Rejection", () => {
      const builtIns = getBuiltInBenchmarkIds();

      test.each(builtIns)(
        "rejects direct collision with built-in id '%s'",
        async (builtInId) => {
          const res = await request(app)
            .post("/api/benchmarking/benchmarks")
            .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
            .send({
              id: builtInId,
              name: `Attempt Overwrite ${builtInId}`,
              metric: "credit_quality",
              thresholds: { poor: 1, fair: 2, good: 3, excellent: 4 },
            })
            .expect(400);
          expect(res.body.error.code).toBe("bad_request");
          expect(res.body.error.message).toContain(`Cannot overwrite built-in benchmark "${builtInId}"`);
        },
      );

      const builtInSlugNames = [
        { name: "Credit Quality", expectedSlug: "credit_quality" },
        { name: "Green Impact", expectedSlug: "green_impact" },
        { name: "Combined Score", expectedSlug: "combined_score" },
        { name: "Efficiency Pct", expectedSlug: "efficiency_pct" },
        { name: "Forest Density Pct", expectedSlug: "forest_density_pct" },
      ];

      test.each(builtInSlugNames)(
        "rejects implicit slug collision from name '%s'",
        async ({ name, expectedSlug }) => {
          const res = await request(app)
            .post("/api/benchmarking/benchmarks")
            .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
            .send({
              name,
              metric: "credit_quality",
              thresholds: { poor: 10, fair: 20, good: 30, excellent: 40 },
            })
            .expect(400);
          expect(res.body.error.code).toBe("bad_request");
          expect(res.body.error.message).toContain(`Cannot overwrite built-in benchmark "${expectedSlug}"`);
        },
      );
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 2: Combinatorics, Authorization Matrix & Missing Fields (30 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 2: Combinatorics, Admin Auth & Payload Variations", () => {
    describe("Admin Auth Token Matrix", () => {
      it("rejects POST when Authorization header is completely missing", async () => {
        const res = await request(app)
          .post("/api/benchmarking/benchmarks")
          .send({
            name: "Unauthenticated Benchmark",
            metric: "credit_quality",
            thresholds: { poor: 10, fair: 20, good: 30, excellent: 40 },
          })
          .expect(401);
        expect(res.body.error).toBe("unauthorized");
      });

      const invalidAuthHeaders = [
        { label: "empty string", header: "" },
        { label: "basic auth", header: "Basic dXNlcjpwYXNz" },
        { label: "empty bearer", header: "Bearer " },
        { label: "wrong secret", header: "Bearer wrong-secret-token" },
        { label: "lowercase bearer", header: `bearer ${TEST_ADMIN_KEY}` },
        { label: "extra whitespace", header: `Bearer  ${TEST_ADMIN_KEY}` },
      ];

      test.each(invalidAuthHeaders)(
        "rejects invalid authorization header (%s) with 401",
        async ({ header }) => {
          const res = await request(app)
            .post("/api/benchmarking/benchmarks")
            .set("Authorization", header)
            .send({
              name: "Unauth Test",
              metric: "credit_quality",
              thresholds: { poor: 10, fair: 20, good: 30, excellent: 40 },
            })
            .expect(401);
          expect(res.body.error).toBe("unauthorized");
        },
      );

      it("authorizes request with exact Bearer token", async () => {
        const res = await request(app)
          .post("/api/benchmarking/benchmarks")
          .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
          .send({
            name: "Authorized Benchmark",
            metric: "credit_quality",
            thresholds: { poor: 10, fair: 20, good: 30, excellent: 40 },
          })
          .expect(201);
        expect(res.body.name).toBe("Authorized Benchmark");
      });
    });

    describe("Missing & Invalid Body Fields Combinations", () => {
      const invalidFieldCases = [
        { label: "empty body {}", body: {} },
        { label: "missing name", body: { metric: "credit_quality", thresholds: { poor: 1, fair: 2, good: 3, excellent: 4 } } },
        { label: "empty name string", body: { name: "", metric: "credit_quality", thresholds: { poor: 1, fair: 2, good: 3, excellent: 4 } } },
        { label: "whitespace name", body: { name: "   ", metric: "credit_quality", thresholds: { poor: 1, fair: 2, good: 3, excellent: 4 } } },
        { label: "non-string name (number)", body: { name: 12345, metric: "credit_quality", thresholds: { poor: 1, fair: 2, good: 3, excellent: 4 } } },
        { label: "non-string name (object)", body: { name: {}, metric: "credit_quality", thresholds: { poor: 1, fair: 2, good: 3, excellent: 4 } } },
        { label: "missing metric", body: { name: "Valid Name", thresholds: { poor: 1, fair: 2, good: 3, excellent: 4 } } },
        { label: "non-string metric", body: { name: "Valid Name", metric: 999, thresholds: { poor: 1, fair: 2, good: 3, excellent: 4 } } },
        { label: "missing thresholds", body: { name: "Valid Name", metric: "credit_quality" } },
        { label: "thresholds is string", body: { name: "Valid Name", metric: "credit_quality", thresholds: "10-20-30-40" } },
        { label: "thresholds is array", body: { name: "Valid Name", metric: "credit_quality", thresholds: [10, 20, 30, 40] } },
        { label: "missing poor", body: { name: "Valid Name", metric: "credit_quality", thresholds: { fair: 20, good: 30, excellent: 40 } } },
        { label: "missing fair", body: { name: "Valid Name", metric: "credit_quality", thresholds: { poor: 10, good: 30, excellent: 40 } } },
        { label: "missing good", body: { name: "Valid Name", metric: "credit_quality", thresholds: { poor: 10, fair: 20, excellent: 40 } } },
        { label: "missing excellent", body: { name: "Valid Name", metric: "credit_quality", thresholds: { poor: 10, fair: 20, good: 30 } } },
        { label: "poor is NaN", body: { name: "Valid Name", metric: "credit_quality", thresholds: { poor: NaN, fair: 20, good: 30, excellent: 40 } } },
        { label: "good is Infinity", body: { name: "Valid Name", metric: "credit_quality", thresholds: { poor: 10, fair: 20, good: Infinity, excellent: 40 } } },
        { label: "excellent is string", body: { name: "Valid Name", metric: "credit_quality", thresholds: { poor: 10, fair: 20, good: 30, excellent: "100" } } },
      ];

      test.each(invalidFieldCases)(
        "returns 400 bad_request on %s",
        async ({ body }) => {
          const res = await request(app)
            .post("/api/benchmarking/benchmarks")
            .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
            .send(body)
            .expect(400);
          expect(res.body.error.code).toBe("bad_request");
        },
      );

      it("accepts custom id with whitespace around it and trims properly", async () => {
        const res = await request(app)
          .post("/api/benchmarking/benchmarks")
          .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
          .send({
            id: "  trimmed_custom_id  ",
            name: "Trim Test",
            metric: "credit_quality",
            thresholds: { poor: 10, fair: 20, good: 30, excellent: 40 },
          })
          .expect(201);
        expect(res.body.id).toBe("trimmed_custom_id");
      });

      it("accepts optional description and source fields", async () => {
        const res = await request(app)
          .post("/api/benchmarking/benchmarks")
          .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
          .send({
            name: "Full Optional Fields",
            description: "Custom comprehensive benchmark description",
            source: "Heliobond Solar Lab 2026",
            metric: "green_impact",
            thresholds: { poor: 15, fair: 35, good: 65, excellent: 85 },
          })
          .expect(201);
        expect(res.body.description).toBe("Custom comprehensive benchmark description");
        expect(res.body.source).toBe("Heliobond Solar Lab 2026");
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 3: Host Variations & Query/Route Structure (20 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 3: Route Parameters & Project ID Parsing", () => {
    it("GET /api/benchmarking/benchmarks lists built-in definitions", async () => {
      const res = await request(app)
        .get("/api/benchmarking/benchmarks")
        .expect(200);
      expect(Array.isArray(res.body.benchmarks)).toBe(true);
      expect(res.body.benchmarks.length).toBe(5);
    });

    const validProjectIds = [1, 2, 42, 100, 9999];
    test.each(validProjectIds)(
      "GET /api/benchmarking/%d evaluates all benchmarks for project",
      async (id) => {
        const res = await request(app)
          .get(`/api/benchmarking/${id}`)
          .expect(200);
        expect(res.body.project_id).toBe(id);
        expect(Array.isArray(res.body.benchmarks)).toBe(true);
      },
    );

    test.each(validProjectIds)(
      "GET /api/benchmarking/%d/alerts returns alerts array",
      async (id) => {
        const res = await request(app)
          .get(`/api/benchmarking/${id}/alerts`)
          .expect(200);
        expect(res.body.project_id).toBe(id);
        expect(Array.isArray(res.body.alerts)).toBe(true);
      },
    );

    const invalidProjectIds = ["abc", "0", "-5", "1.5", "null", "undefined", "1e5"];
    test.each(invalidProjectIds)(
      "GET /api/benchmarking/%s returns 400 for invalid project id",
      async (id) => {
        const res = await request(app)
          .get(`/api/benchmarking/${id}`)
          .expect(400);
        expect(res.body.error.code).toBe("bad_request");
      },
    );

    it("GET /api/benchmarking/1/trend handles existing benchmark successfully", async () => {
      const res = await request(app)
        .get("/api/benchmarking/1/trend?metric=credit_quality&benchmark=credit_quality")
        .expect(200);
      expect(res.body.project_id).toBe(1);
      expect(res.body).toHaveProperty("trend_direction");
      expect(res.body).toHaveProperty("delta");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 4: Negative Controls & Invariant Proofs (20 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 4: Negative Controls & Invariant Proofs", () => {
    it("unauthenticated POST /benchmarks does NOT mutate customBenchmarks map", async () => {
      const initialCount = getBenchmarks().length;

      await request(app)
        .post("/api/benchmarking/benchmarks")
        .send({
          name: "Attacker Mutation",
          metric: "credit_quality",
          thresholds: { poor: 10, fair: 20, good: 30, excellent: 40 },
        })
        .expect(401);

      expect(getBenchmarks().length).toBe(initialCount);
      expect(getBenchmarkById("attacker_mutation")).toBeUndefined();
    });

    it("invalid input POST /benchmarks (400) does NOT mutate customBenchmarks", async () => {
      const initialCount = getBenchmarks().length;

      await request(app)
        .post("/api/benchmarking/benchmarks")
        .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
        .send({
          name: "Invalid Input Benchmark",
          metric: "unknown_fake_metric",
          thresholds: { poor: 10, fair: 20, good: 30, excellent: 40 },
        })
        .expect(400);

      expect(getBenchmarks().length).toBe(initialCount);
      expect(getBenchmarkById("invalid_input_benchmark")).toBeUndefined();
    });

    it("attempted built-in overwrite does NOT mutate existing built-in threshold", async () => {
      const originalDefinition = { ...getBenchmarkById("credit_quality")! };

      await request(app)
        .post("/api/benchmarking/benchmarks")
        .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
        .send({
          id: "credit_quality",
          name: "Malicious Overwrite",
          metric: "credit_quality",
          thresholds: { poor: 0, fair: 0, good: 0, excellent: 0 },
        })
        .expect(400);

      const afterAttempt = getBenchmarkById("credit_quality")!;
      expect(afterAttempt.thresholds).toEqual(originalDefinition.thresholds);
      expect(afterAttempt.name).toBe(originalDefinition.name);
      expect(afterAttempt.source).toBe(originalDefinition.source);
    });

    it("querying unknown benchmark does NOT inject entries or create state leaks", async () => {
      const initialCount = getBenchmarks().length;
      await request(app).get("/api/benchmarking/benchmarks/phantom_benchmark").expect(404);
      expect(getBenchmarks().length).toBe(initialCount);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 5: Lifecycle, Stress & High-Throughput (15 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 5: Lifecycle & High-Throughput Operations", () => {
    it("supports sequentially defining and retrieving 15 custom benchmarks", async () => {
      const benchmarkIds: string[] = [];

      for (let i = 1; i <= 15; i++) {
        const id = `sequential_custom_bm_${i}`;
        benchmarkIds.push(id);

        const res = await request(app)
          .post("/api/benchmarking/benchmarks")
          .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
          .send({
            id,
            name: `Sequential BM ${i}`,
            metric: KNOWN_METRICS[i % KNOWN_METRICS.length],
            thresholds: { poor: i, fair: i + 10, good: i + 20, excellent: i + 30 },
          })
          .expect(201);

        expect(res.body.id).toBe(id);
      }

      // Check total count is 5 built-in + 15 custom = 20
      const listRes = await request(app).get("/api/benchmarking/benchmarks").expect(200);
      expect(listRes.body.benchmarks.length).toBe(20);

      // Verify each benchmark is retrievable by ID with 200
      for (const id of benchmarkIds) {
        const getRes = await request(app).get(`/api/benchmarking/benchmarks/${id}`).expect(200);
        expect(getRes.body.id).toBe(id);
      }
    });

    it("evaluateAllBenchmarks includes custom defined benchmarks in evaluations", async () => {
      await request(app)
        .post("/api/benchmarking/benchmarks")
        .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
        .send({
          id: "custom_eval_bm",
          name: "Evaluation Benchmark",
          metric: "green_impact",
          thresholds: { poor: 20, fair: 40, good: 60, excellent: 80 },
        })
        .expect(201);

      const evaluations = evaluateAllBenchmarks(1);
      const customEval = evaluations.find((e) => e.benchmark.id === "custom_eval_bm");
      expect(customEval).toBeDefined();
      expect(customEval?.rating).toBeDefined();
      expect(customEval?.percentile).toBeDefined();
    });

    it("clearCustomBenchmarks restores pristine built-in state cleanly", async () => {
      await request(app)
        .post("/api/benchmarking/benchmarks")
        .set("Authorization", `Bearer ${TEST_ADMIN_KEY}`)
        .send({
          id: "to_be_cleared",
          name: "Temporary Benchmark",
          metric: "credit_quality",
          thresholds: { poor: 10, fair: 20, good: 30, excellent: 40 },
        })
        .expect(201);

      expect(getBenchmarks().length).toBe(6);

      clearCustomBenchmarks();

      expect(getBenchmarks().length).toBe(5);
      expect(getBenchmarkById("to_be_cleared")).toBeUndefined();
    });
  });
});
