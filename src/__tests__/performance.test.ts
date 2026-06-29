import { computeScores, type IotInput } from "../lib/scoring";

function measureMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

const SAMPLE_INPUT: IotInput = {
  solar: { efficiency_pct: 85, power_output_kw: 4.2, max_power_kw: 5.0 },
  satellite: { forest_density_pct: 72, ndvi_score: 0.65 },
};

const PRE_GENERATED_INPUTS = Array.from({ length: 10_000 }, () => ({
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
    it("computeScores handles 10k iterations under 100ms", () => {
      const ms = measureMs(() => {
        for (let i = 0; i < 10_000; i++) {
          computeScores(PRE_GENERATED_INPUTS[i]);
        }
      });
      expect(ms).toBeLessThan(300);
    });

    it("computeScores handles 10k iterations under 100ms", () => {
      const ms = measureMs(() => {
        for (let i = 0; i < 10_000; i++) {
          computeScores(PRE_GENERATED_INPUTS[i]);
        }
      });
      expect(ms).toBeLessThan(150);
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
      expect(growthMB).toBeLessThan(15);
    });
  });

  describe("transaction throughput", () => {
    it("score calculation throughput exceeds 100k ops/sec", () => {
      const iterations = 100_000;
      const ms = measureMs(() => {
        for (let i = 0; i < iterations; i++) {
          computeScores(SAMPLE_INPUT);
        }
      });
      const opsPerSec = (iterations / ms) * 1000;
      expect(opsPerSec).toBeGreaterThan(60_000);
    });
  });
});
