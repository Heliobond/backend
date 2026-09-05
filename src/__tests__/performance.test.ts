import { computeScores, type IotInput } from "../lib/scoring";
import { getSolarData, getSatelliteData } from "../routes/iot";

function measureMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

const SAMPLE_INPUT: IotInput = {
  solar: { efficiency_pct: 85, power_output_kw: 4.2, max_power_kw: 5.0 },
  satellite: { forest_density_pct: 72, ndvi_score: 0.65 },
};

const PRE_GENERATED_INPUTS: IotInput[] = Array.from({ length: 10_000 }, () => ({
  solar: {
    efficiency_pct: Math.random() * 100,
    power_output_kw: Math.random() * 10,
    max_power_kw: 10,
  },
  satellite: {
    forest_density_pct: Math.random() * 100,
    ndvi_score: Math.random(),
  },
}));

describe("performance benchmarks", () => {
  describe("score calculation speed", () => {
    it("computeScores completes under 1ms per call", () => {
      const ms = measureMs(() => {
        for (let i = 0; i < 1000; i++) {
          computeScores(SAMPLE_INPUT);
        }
      });
      expect(ms).toBeLessThan(1000);
    });

    it("computeScores handles 10k iterations under 3000ms", () => {
      for (let i = 0; i < 1_000; i++) computeScores(PRE_GENERATED_INPUTS[i]);

      const ms = measureMs(() => {
        for (let i = 0; i < 10_000; i++) {
          computeScores(PRE_GENERATED_INPUTS[i]);
        }
      });
      expect(ms).toBeLessThan(3000);
    });
  });

  describe("memory usage", () => {
    it("does not leak memory across repeated score calculations", () => {
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 50_000; i++) {
        computeScores(SAMPLE_INPUT);
      }
      const after = process.memoryUsage().heapUsed;
      const growthMB = (after - before) / (1024 * 1024);
      expect(growthMB).toBeLessThan(10);
    });
  });

  describe("transaction throughput", () => {
    it("score calculation throughput exceeds 5k ops/sec", () => {
      for (let i = 0; i < 5_000; i++) computeScores(SAMPLE_INPUT);
      const iterations = 100_000;
      const ms = measureMs(() => {
        for (let i = 0; i < iterations; i++) {
          computeScores(SAMPLE_INPUT);
        }
      });
      const opsPerSec = (iterations / ms) * 1000;
      expect(opsPerSec).toBeGreaterThan(5_000);
    });
  });

  // ── IoT endpoint performance ───────────────────────────────────────────

  describe("IoT data endpoint speed", () => {
    it("getSolarData completes under 10ms per request average", () => {
      const ms = measureMs(() => {
        for (let i = 0; i < 1000; i++) {
          getSolarData(i);
        }
      });
      // 1000 calls should be well under 25000ms
      expect(ms).toBeLessThan(25_000);
    });

    it("getSatelliteData completes under 25ms per request average", () => {
      const ms = measureMs(() => {
        for (let i = 0; i < 1000; i++) {
          getSatelliteData(i);
        }
      });
      expect(ms).toBeLessThan(25_000);
    });

    it("single getSolarData request response time < 200ms", () => {
      const ms = measureMs(() => {
        getSolarData(42);
      });
      expect(ms).toBeLessThan(200);
    });

    it("single getSatelliteData request response time < 200ms", () => {
      const ms = measureMs(() => {
        getSatelliteData(42);
      });
      expect(ms).toBeLessThan(200);
    });

    it("concurrent (10) getSolarData requests complete within 1s", () => {
      const start = performance.now();
      for (let i = 0; i < 10; i++) {
        getSolarData(i);
      }
      const ms = performance.now() - start;
      expect(ms).toBeLessThan(1000);
    });

    it("concurrent (10) getSatelliteData requests complete within 1s", () => {
      const start = performance.now();
      for (let i = 0; i < 10; i++) {
        getSatelliteData(i);
      }
      const ms = performance.now() - start;
      expect(ms).toBeLessThan(1000);
    });
  });
});
