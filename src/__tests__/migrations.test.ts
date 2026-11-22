import {
  runMigrations,
  rollbackMigration,
  rollbackAll,
  getMigrationStatus,
  makeMigration,
  validateMigrations,
  getMigrationHealth,
  closeKnexInstance,
} from "../lib/migrations";

// Skip all migration tests if no database is available
const DB_URL = process.env.DB_HOST || "localhost";

describe("schema migrations", () => {
  afterAll(async () => {
    await closeKnexInstance();
  });

  // Only run integration tests when a database is available
  const describeDb = process.env.TEST_DB === "true" ? describe : describe.skip;

  describeDb("runMigrations", () => {
    it("runs pending migrations successfully", async () => {
      const result = await runMigrations();
      expect(result.success).toBe(true);
      expect(Array.isArray(result.completed)).toBe(true);
      expect(Array.isArray(result.pending)).toBe(true);
    });

    it("is idempotent — running again completes with zero migrations", async () => {
      const result = await runMigrations();
      expect(result.success).toBe(true);
      expect(result.completed.length).toBe(0);
    });
  });

  describeDb("rollbackMigration", () => {
    it("rolls back the last batch", async () => {
      const result = await rollbackMigration();
      expect(result.success).toBe(true);
      expect(Array.isArray(result.completed)).toBe(true);
    });

    it("reports nothing to rollback when at baseline", async () => {
      // Rollback everything first
      await rollbackAll();
      const result = await rollbackMigration();
      expect(result.completed.length).toBe(0);
    });
  });

  describeDb("getMigrationStatus", () => {
    it("returns current and pending lists", async () => {
      const status = await getMigrationStatus();
      expect(Array.isArray(status.current)).toBe(true);
      expect(Array.isArray(status.pending)).toBe(true);
    });
  });

  describeDb("validateMigrations", () => {
    it("validates migration file integrity", async () => {
      const result = await validateMigrations();
      expect(result.valid).toBe(true);
      expect(Array.isArray(result.missing)).toBe(true);
    });
  });

  describeDb("getMigrationHealth", () => {
    it("returns a health report", async () => {
      const health = await getMigrationHealth();
      expect(["healthy", "degraded", "unhealthy"]).toContain(health.status);
      expect(typeof health.applied_count).toBe("number");
      expect(typeof health.pending_count).toBe("number");
    });
  });

  // These tests don't need a database
  describe("makeMigration", () => {
    it("is a function", () => {
      expect(typeof makeMigration).toBe("function");
    });
  });

  describe("module exports", () => {
    it("exports all expected functions", () => {
      expect(typeof runMigrations).toBe("function");
      expect(typeof rollbackMigration).toBe("function");
      expect(typeof rollbackAll).toBe("function");
      expect(typeof getMigrationStatus).toBe("function");
      expect(typeof makeMigration).toBe("function");
      expect(typeof validateMigrations).toBe("function");
      expect(typeof getMigrationHealth).toBe("function");
      expect(typeof closeKnexInstance).toBe("function");
    });
  });
});
