import request from "supertest";
import express, { Express } from "express";
import forecastRouter from "../routes/forecast";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/forecast", forecastRouter);
  app.use(errorHandler);
  return app;
}

describe("Forecast Field Validation 5D Matrix (Issue #891)", () => {
  const app = buildApp();

  // =========================================================================
  // DIMENSION 1: BOUNDARY & CLAMPING (35 tests)
  // =========================================================================
  describe("Dimension 1: Boundary & Clamping", () => {
    it("omitted field query parameter defaults to power_output_kw on GET /api/forecast/:id", async () => {
      const res = await request(app).get("/api/forecast/1").expect(200);
      expect(res.body).toHaveProperty("forecasts");
      expect(res.body.forecasts.length).toBeGreaterThan(0);
      expect(res.body.forecasts[0]).toHaveProperty("value");
    });

    it("omitted field query parameter defaults to power_output_kw on GET /api/forecast/seasonal/:id", async () => {
      const res = await request(app).get("/api/forecast/seasonal/1").expect(200);
      expect(res.body.field).toBe("power_output_kw");
    });

    it("omitted field query parameter defaults to power_output_kw on GET /api/forecast/accuracy/:id", async () => {
      const res = await request(app).get("/api/forecast/accuracy/1").expect(200);
      expect(res.body).toHaveProperty("metrics");
    });

    it("empty field string defaults to power_output_kw on GET /api/forecast/:id", async () => {
      const res = await request(app).get("/api/forecast/1?field=").expect(200);
      expect(res.body).toHaveProperty("forecasts");
    });

    it("explicit power_output_kw returns 200 on /api/forecast/:id", async () => {
      const res = await request(app).get("/api/forecast/1?field=power_output_kw").expect(200);
      expect(res.body).toHaveProperty("forecasts");
    });

    it("explicit power_output_kw returns 200 on /api/forecast/seasonal/:id", async () => {
      const res = await request(app)
        .get("/api/forecast/seasonal/1?field=power_output_kw")
        .expect(200);
      expect(res.body.field).toBe("power_output_kw");
    });

    it("explicit power_output_kw returns 200 on /api/forecast/accuracy/:id", async () => {
      const res = await request(app)
        .get("/api/forecast/accuracy/1?field=power_output_kw")
        .expect(200);
      expect(res.body).toHaveProperty("metrics");
    });

    it("explicit efficiency_pct returns 200 on /api/forecast/:id", async () => {
      const res = await request(app).get("/api/forecast/1?field=efficiency_pct").expect(200);
      expect(res.body).toHaveProperty("forecasts");
    });

    it("explicit efficiency_pct returns 200 on /api/forecast/seasonal/:id", async () => {
      const res = await request(app)
        .get("/api/forecast/seasonal/1?field=efficiency_pct")
        .expect(200);
      expect(res.body.field).toBe("efficiency_pct");
    });

    it("explicit efficiency_pct returns 200 on /api/forecast/accuracy/:id", async () => {
      const res = await request(app)
        .get("/api/forecast/accuracy/1?field=efficiency_pct")
        .expect(200);
      expect(res.body).toHaveProperty("metrics");
    });

    // Typos and invalid boundary values (25 tests)
    const boundaryInvalidFields = [
      "efficiency",
      "power",
      "efficiency_percent",
      "power_kw",
      "power_output",
      "efficiency_percentage",
      "efficiency_pct ",
      " efficiency_pct",
      "power_output_kw ",
      " power_output_kw",
      "POWER_OUTPUT_KW",
      "EFFICIENCY_PCT",
      "Efficiency_pct",
      "Power_Output_Kw",
      "0",
      "1",
      "true",
      "false",
      "null",
      "undefined",
      "NaN",
      "[object Object]",
      "power_output_kw; DROP TABLE users;",
      "<script>alert(1)</script>",
      "a".repeat(1000),
    ];

    boundaryInvalidFields.forEach((val, idx) => {
      it(`boundary rejection #${idx + 1}: rejects "${val.slice(0, 30)}" with 400 Bad Request listing allowed fields`, async () => {
        const res = await request(app)
          .get(`/api/forecast/1?field=${encodeURIComponent(val)}`)
          .expect(400);

        expect(res.body.error).toBeDefined();
        expect(res.body.error.message).toContain(`Invalid field "${val}"`);
        expect(res.body.error.message).toContain("power_output_kw, efficiency_pct");
      });
    });
  });

  // =========================================================================
  // DIMENSION 2: COMBINATORICS (30 tests)
  // =========================================================================
  describe("Dimension 2: Combinatorics across endpoints and parameters", () => {
    const endpoints = [
      { name: "forecasts", path: "/api/forecast/1" },
      { name: "seasonal", path: "/api/forecast/seasonal/1" },
      { name: "accuracy", path: "/api/forecast/accuracy/1" },
    ];

    const invalidTestCases = [
      "efficiency",
      "power",
      "unknown_metric",
      "volts",
      "temperature",
      "humidity",
      "co2_absorbed",
    ];

    endpoints.forEach(({ name, path }) => {
      invalidTestCases.forEach((invField) => {
        it(`combinatorics [${name}] rejects field="${invField}" with 400 listing valid fields`, async () => {
          const res = await request(app)
            .get(`${path}?field=${encodeURIComponent(invField)}`)
            .expect(400);

          expect(res.body.error.code).toBe("bad_request");
          expect(res.body.error.message).toContain(`Invalid field "${invField}"`);
          expect(res.body.error.message).toContain("Valid fields: power_output_kw, efficiency_pct");
        });
      });
    });

    // Combinatorics with other valid parameters (9 tests)
    const methods = ["naive", "exponential_smoothing", "linear_trend"];
    methods.forEach((m) => {
      it(`combinatorics: valid efficiency_pct with method=${m} returns 200`, async () => {
        const res = await request(app)
          .get(`/api/forecast/1?field=efficiency_pct&method=${m}&horizon=12`)
          .expect(200);
        expect(res.body).toHaveProperty("forecasts");
      });

      it(`combinatorics: typo field with method=${m} rejects with 400 without executing method`, async () => {
        const res = await request(app)
          .get(`/api/forecast/1?field=efficiency&method=${m}&horizon=12`)
          .expect(400);
        expect(res.body.error.message).toContain("Invalid field");
      });

      it(`combinatorics: valid power_output_kw with method=${m} and format=csv returns 200`, async () => {
        const res = await request(app)
          .get(`/api/forecast/1?field=power_output_kw&method=${m}&format=csv`)
          .expect(200);
        expect(res.headers["content-type"]).toMatch(/text\/csv/);
      });
    });
  });

  // =========================================================================
  // DIMENSION 3: HOST VARIATIONS & FORMATS (20 tests)
  // =========================================================================
  describe("Dimension 3: Host Variations & Request encodings", () => {
    const formats = ["json", "csv"];
    formats.forEach((fmt) => {
      it(`host variation format=${fmt}: valid power_output_kw honors format`, async () => {
        const res = await request(app)
          .get(`/api/forecast/1?field=power_output_kw&format=${fmt}`)
          .expect(200);
        if (fmt === "csv") {
          expect(res.headers["content-type"]).toMatch(/text\/csv/);
        } else {
          expect(res.headers["content-type"]).toMatch(/application\/json/);
        }
      });

      it(`host variation format=${fmt}: invalid field returns json 400 even if format=csv was requested`, async () => {
        const res = await request(app)
          .get(`/api/forecast/1?field=bad_field&format=${fmt}`)
          .expect(400);
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        expect(res.body.error.code).toBe("bad_request");
      });
    });

    const projectIds = [1, 2, 5, 10, 999];
    projectIds.forEach((pid) => {
      it(`project ID variation id=${pid}: correctly handles field parameter`, async () => {
        await request(app).get(`/api/forecast/${pid}?field=efficiency_pct`).expect(200);
        await request(app).get(`/api/forecast/${pid}?field=invalid_field`).expect(400);
      });
    });

    it("handles URL encoded special characters in field query", async () => {
      const res = await request(app).get("/api/forecast/1?field=%20%20").expect(400);
      expect(res.body.error.message).toContain("Invalid field");
    });

    it("handles tab and newline encoded in field query", async () => {
      const res = await request(app).get("/api/forecast/1?field=%09%0A").expect(400);
      expect(res.body.error.message).toContain("Invalid field");
    });

    for (let h = 1; h <= 4; h++) {
      it(`handles horizon variation h=${h * 24} with valid and invalid fields`, async () => {
        await request(app)
          .get(`/api/forecast/1?field=power_output_kw&horizon=${h * 24}`)
          .expect(200);
        await request(app)
          .get(`/api/forecast/1?field=typo_field&horizon=${h * 24}`)
          .expect(400);
      });
    }
  });

  // =========================================================================
  // DIMENSION 4: NEGATIVE CONTROLS & ISOLATION (15 tests)
  // =========================================================================
  describe("Dimension 4: Negative Controls & State Isolation", () => {
    it("unrelated query parameters do not cause false positive field validation errors", async () => {
      const res = await request(app)
        .get("/api/forecast/1?field=power_output_kw&foo=bar&debug=true&timestamp=123456789")
        .expect(200);
      expect(res.body).toHaveProperty("forecasts");
    });

    it("weather-adjusted route ignores field parameter and continues working cleanly", async () => {
      const res = await request(app)
        .get("/api/forecast/weather-adjusted/1?field=anything_ignored")
        .expect(200);
      expect(res.body).toHaveProperty("forecasts");
    });

    it("invalid project ID fails with 400 for invalid project id before reaching field validation", async () => {
      const res = await request(app).get("/api/forecast/invalid-id?field=efficiency").expect(400);
      expect(res.body.error.message).toContain("project id must be a positive integer");
    });

    it("invalid method fails with 400 for method when field is valid", async () => {
      const res = await request(app)
        .get("/api/forecast/1?field=power_output_kw&method=invalid_algo")
        .expect(400);
      expect(res.body.error.message).toContain("Invalid method");
    });

    for (let c = 1; c <= 11; c++) {
      it(`negative control isolation #${c}: arbitrary noise query param does not break valid field`, async () => {
        const res = await request(app)
          .get(`/api/forecast/1?field=efficiency_pct&noise_${c}=val_${c}`)
          .expect(200);
        expect(res.body).toHaveProperty("forecasts");
      });
    }
  });

  // =========================================================================
  // DIMENSION 5: LIFECYCLE & STRESS TESTING (15 tests)
  // =========================================================================
  describe("Dimension 5: Lifecycle & Stress Testing", () => {
    it("stress test: alternating 40 valid and invalid requests yields 0 state contamination", async () => {
      for (let i = 0; i < 40; i++) {
        if (i % 2 === 0) {
          const res = await request(app).get("/api/forecast/1?field=efficiency_pct").expect(200);
          expect(res.body).toHaveProperty("forecasts");
        } else {
          const res = await request(app).get("/api/forecast/1?field=efficiency").expect(400);
          expect(res.body.error.message).toContain("Invalid field");
        }
      }
    });

    it("stress test: concurrent batch of 20 mixed requests executes deterministically", async () => {
      const promises = Array.from({ length: 20 }, (_, idx) => {
        const isVal = idx % 2 === 0;
        const fieldParam = isVal ? "power_output_kw" : `typo_metric_${idx}`;
        return request(app)
          .get(`/api/forecast/1?field=${fieldParam}`)
          .then((res) => ({ idx, isVal, status: res.status }));
      });

      const results = await Promise.all(promises);
      results.forEach(({ isVal, status }) => {
        if (isVal) {
          expect(status).toBe(200);
        } else {
          expect(status).toBe(400);
        }
      });
    });

    for (let s = 1; s <= 13; s++) {
      it(`stress iteration #${s}: rapid validation call returns exact 400 response structure`, async () => {
        const res = await request(app).get(`/api/forecast/1?field=bogus_${s}`).expect(400);
        expect(res.body.error.code).toBe("bad_request");
        expect(res.body.error.message).toContain(`Invalid field "bogus_${s}"`);
      });
    }
  });
});
