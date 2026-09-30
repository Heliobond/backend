import {
  validateAnomalyConfig,
  configureAnomalyDetection,
  getAnomalyConfig,
  detectAnomalies,
  clearHistory,
  AnomalyValidationError,
} from "../lib/anomaly";

describe("Anomaly Detection Engine", () => {
  beforeEach(() => {
    clearHistory();
    configureAnomalyDetection({
      sensitivityZScore: 2.5,
      trendWindowSize: 20,
      trendDeviationPct: 20,
      minBaseline: 5,
    });
  });

  describe("validateAnomalyConfig", () => {
    it("validates correct config", () => {
      const valid = validateAnomalyConfig({ sensitivityZScore: 3, minBaseline: 10 });
      expect(valid.sensitivityZScore).toBe(3);
      expect(valid.minBaseline).toBe(10);
    });

    it("throws on invalid sensitivityZScore", () => {
      expect(() => validateAnomalyConfig({ sensitivityZScore: -1 })).toThrow(
        AnomalyValidationError,
      );
      expect(() => validateAnomalyConfig({ sensitivityZScore: "high" as any })).toThrow(
        AnomalyValidationError,
      );
    });

    it("throws on invalid trendWindowSize", () => {
      expect(() => validateAnomalyConfig({ trendWindowSize: 0 })).toThrow(AnomalyValidationError);
    });

    it("throws on invalid trendDeviationPct", () => {
      expect(() => validateAnomalyConfig({ trendDeviationPct: -10 })).toThrow(
        AnomalyValidationError,
      );
    });

    it("throws on invalid minBaseline", () => {
      expect(() => validateAnomalyConfig({ minBaseline: 0 })).toThrow(AnomalyValidationError);
    });
  });

  describe("configureAnomalyDetection and getAnomalyConfig", () => {
    it("updates global config correctly", () => {
      configureAnomalyDetection({ trendWindowSize: 30 });
      const config = getAnomalyConfig();
      expect(config.trendWindowSize).toBe(30);
      expect(config.sensitivityZScore).toBe(2.5); // Remains default
    });
  });

  describe("detectAnomalies", () => {
    const baseReadings = {
      efficiency_pct: 80,
      power_output_kw: 500,
      forest_density_pct: 60,
      ndvi_score: 0.6,
    };

    it("returns mean and standard deviation of 0 if history is less than minBaseline", () => {
      const res = detectAnomalies(1, baseReadings);
      expect(res.anomalies).toHaveLength(0);
      expect(res.metrics.efficiency_pct.mean).toBe(80);
      expect(res.metrics.efficiency_pct.stdDev).toBe(0);
      expect(res.metrics.efficiency_pct.zScore).toBe(0);
    });

    it("does not detect outlier if stdDev is 0 (all historical values are identical)", () => {
      for (let i = 0; i < 5; i++) {
        detectAnomalies(1, baseReadings);
      }

      const outlierReadings = { ...baseReadings, power_output_kw: 1000 };
      const res = detectAnomalies(1, outlierReadings);

      // Since stdDev is 0, zScore is 0, so no outlier alert should be raised
      const outlierAlert = res.anomalies.find(
        (a) => a.type === "outlier" && a.metric === "power_output_kw",
      );
      expect(outlierAlert).toBeUndefined();
    });

    it("detects outlier anomaly with actual stdDev", () => {
      const readings = [
        { ...baseReadings, power_output_kw: 490 },
        { ...baseReadings, power_output_kw: 500 },
        { ...baseReadings, power_output_kw: 510 },
        { ...baseReadings, power_output_kw: 495 },
        { ...baseReadings, power_output_kw: 505 },
      ];

      for (const r of readings) {
        detectAnomalies(1, r);
      }

      const outlierReadings = { ...baseReadings, power_output_kw: 1000 };
      const res = detectAnomalies(1, outlierReadings);

      const outlierAlert = res.anomalies.find(
        (a) => a.type === "outlier" && a.metric === "power_output_kw",
      );
      expect(outlierAlert).toBeDefined();
      expect(outlierAlert?.value).toBe(1000);
      expect(Math.abs(outlierAlert!.deviation)).toBeGreaterThan(2.5);
      expect(outlierAlert?.severity).toBe("high");
    });

    it("detects trend anomaly", () => {
      const readings = [
        { ...baseReadings, efficiency_pct: 90 },
        { ...baseReadings, efficiency_pct: 90 },
        { ...baseReadings, efficiency_pct: 90 },
        { ...baseReadings, efficiency_pct: 90 },
        { ...baseReadings, efficiency_pct: 90 },
      ];
      for (const r of readings) {
        detectAnomalies(1, r);
      }

      // 20% drop from 90 is 72.
      const res = detectAnomalies(1, { ...baseReadings, efficiency_pct: 70 });
      const trendAlert = res.anomalies.find(
        (a) => a.type === "trend" && a.metric === "efficiency_pct",
      );
      expect(trendAlert).toBeDefined();
      expect(trendAlert?.value).toBe(70);
      expect(trendAlert?.deviation).toBeLessThan(-20);
    });

    it("respects custom config provided during call", () => {
      const readings = [
        { ...baseReadings, power_output_kw: 490 },
        { ...baseReadings, power_output_kw: 500 },
        { ...baseReadings, power_output_kw: 510 },
        { ...baseReadings, power_output_kw: 495 },
        { ...baseReadings, power_output_kw: 505 },
      ];
      for (const r of readings) {
        detectAnomalies(1, r);
      }

      // Send 520, which is barely an outlier if sensitivity is very low
      const res = detectAnomalies(
        1,
        { ...baseReadings, power_output_kw: 520 },
        { sensitivityZScore: 0.1 },
      );
      const outlierAlert = res.anomalies.find(
        (a) => a.type === "outlier" && a.metric === "power_output_kw",
      );
      expect(outlierAlert).toBeDefined();
    });
  });

  describe("clearHistory", () => {
    it("clears specific project history", () => {
      const baseReadings = {
        efficiency_pct: 80,
        power_output_kw: 500,
        forest_density_pct: 60,
        ndvi_score: 0.6,
      };
      for (let i = 0; i < 5; i++) detectAnomalies(1, baseReadings);

      clearHistory(1);

      const res = detectAnomalies(1, baseReadings);
      expect(res.metrics.efficiency_pct.stdDev).toBe(0);
    });

    it("clears all project history", () => {
      const baseReadings = {
        efficiency_pct: 80,
        power_output_kw: 500,
        forest_density_pct: 60,
        ndvi_score: 0.6,
      };
      for (let i = 0; i < 5; i++) {
        detectAnomalies(1, baseReadings);
        detectAnomalies(2, baseReadings);
      }

      clearHistory();

      const res1 = detectAnomalies(1, baseReadings);
      const res2 = detectAnomalies(2, baseReadings);
      expect(res1.metrics.efficiency_pct.stdDev).toBe(0);
      expect(res2.metrics.efficiency_pct.stdDev).toBe(0);
    });
  });
});
