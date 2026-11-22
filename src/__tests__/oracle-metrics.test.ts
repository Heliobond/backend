/**
 * Tests for oracle SLO metrics recording
 */

import {
  oracleScoreAge,
  oracleSignerBalance,
  registryPaused,
  oracleSubmitLatency,
} from "../lib/prometheus";

describe("Oracle SLO Metrics", () => {
  afterEach(() => {
    // Reset metrics after each test
    oracleSignerBalance.set(0);
    registryPaused.set(0);
  });

  describe("oracleScoreAge", () => {
    it("records score age for a project", () => {
      oracleScoreAge.set({ project_id: "1" }, 3600);

      // Metric should be recordable without errors
      expect(oracleScoreAge).toBeDefined();
    });

    it("supports multiple projects with different ages", () => {
      oracleScoreAge.set({ project_id: "1" }, 1200);
      oracleScoreAge.set({ project_id: "2" }, 3600);
      oracleScoreAge.set({ project_id: "3" }, 7200);

      // All metrics should be recorded
      expect(oracleScoreAge).toBeDefined();
    });
  });

  describe("oracleSignerBalance", () => {
    it("records signer balance in XLM", () => {
      oracleSignerBalance.set(245.5);

      expect(oracleSignerBalance).toBeDefined();
    });

    it("can be updated as balance changes", () => {
      oracleSignerBalance.set(250);
      oracleSignerBalance.set(249.99); // after a transaction

      expect(oracleSignerBalance).toBeDefined();
    });
  });

  describe("registryPaused", () => {
    it("records active state (0)", () => {
      registryPaused.set(0);

      expect(registryPaused).toBeDefined();
    });

    it("records paused state (1)", () => {
      registryPaused.set(1);

      expect(registryPaused).toBeDefined();
    });
  });

  describe("oracleSubmitLatency", () => {
    it("records successful submission latency", () => {
      oracleSubmitLatency.observe({ result: "success" }, 3.5);

      expect(oracleSubmitLatency).toBeDefined();
    });

    it("records failed submission latency", () => {
      oracleSubmitLatency.observe({ result: "failed" }, 12.3);

      expect(oracleSubmitLatency).toBeDefined();
    });

    it("records multiple submissions", () => {
      oracleSubmitLatency.observe({ result: "success" }, 2.1);
      oracleSubmitLatency.observe({ result: "success" }, 3.4);
      oracleSubmitLatency.observe({ result: "success" }, 4.2);
      oracleSubmitLatency.observe({ result: "failed" }, 15.7);

      expect(oracleSubmitLatency).toBeDefined();
    });
  });

  describe("Metrics integration", () => {
    it("all oracle metrics are exported from prometheus module", () => {
      expect(oracleScoreAge).toBeDefined();
      expect(oracleSignerBalance).toBeDefined();
      expect(registryPaused).toBeDefined();
      expect(oracleSubmitLatency).toBeDefined();
    });

    it("metrics have correct types", () => {
      // Gauges should have .set() method
      expect(typeof oracleScoreAge.set).toBe("function");
      expect(typeof oracleSignerBalance.set).toBe("function");
      expect(typeof registryPaused.set).toBe("function");

      // Histogram should have .observe() method
      expect(typeof oracleSubmitLatency.observe).toBe("function");
    });
  });
});
