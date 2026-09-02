/**
 * Unit tests for src/lib/duplicate-detection.ts — cron job concurrency guard.
 *
 * Tests verify that:
 * - Concurrent cron runs are prevented (second run is skipped with warning)
 * - Lock is released after successful completion
 * - Lock is released after failure
 */

jest.mock("../lib/logger", () => ({
  logger: {
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { tryBeginUpdate, markCompleted, markFailed } from "../lib/duplicate-detection";
import { logger } from "../lib/logger";

describe("duplicate-detection (cron concurrency guard)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    markCompleted("project-1");
    markCompleted("project-2");
    markCompleted(123);
    markCompleted("concurrent-test");
  });

  it("allows first update attempt for a given ID", () => {
    const result = tryBeginUpdate("project-1");

    expect(result.allowed).toBe(true);
    expect(result.key).toMatch(/^lock-project-1-\d+$/);
    expect(result.reason).toBe("");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips concurrent update attempt with warning when lock is held", () => {
    // First attempt acquires lock
    tryBeginUpdate("project-1");

    // Second attempt while lock is held
    const result = tryBeginUpdate("project-1");

    expect(result.allowed).toBe(false);
    expect(result.key).toBe("");
    expect(result.reason).toMatch(/Update already in progress since/);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[duplicate-detection] Skipping update for project-1:"),
    );
  });

  it("allows update for different IDs concurrently", () => {
    const result1 = tryBeginUpdate("project-1");
    const result2 = tryBeginUpdate("project-2");

    expect(result1.allowed).toBe(true);
    expect(result2.allowed).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("releases lock after successful completion", () => {
    tryBeginUpdate("project-1");

    markCompleted("project-1");

    // Should allow new attempt after lock is released
    const result = tryBeginUpdate("project-1");
    expect(result.allowed).toBe(true);
    expect(logger.debug).toHaveBeenCalledWith(
      "[duplicate-detection] Lock released for project-1 after successful completion",
    );
  });

  it("releases lock after failure", () => {
    tryBeginUpdate("project-1");

    markFailed("project-1");

    // Should allow new attempt after lock is released
    const result = tryBeginUpdate("project-1");
    expect(result.allowed).toBe(true);
    expect(logger.debug).toHaveBeenCalledWith(
      "[duplicate-detection] Lock released for project-1 after failure",
    );
  });

  it("prevents concurrent runs with simulated concurrent execution", async () => {
    const projectId = "concurrent-test";

    // First run acquires lock
    const firstRun = tryBeginUpdate(projectId);
    expect(firstRun.allowed).toBe(true);

    // Simulate second run starting immediately after
    const secondRun = tryBeginUpdate(projectId);
    expect(secondRun.allowed).toBe(false);
    expect(secondRun.reason).toMatch(/Update already in progress/);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Complete first run
    markCompleted(projectId);

    // Third run after completion should succeed
    const thirdRun = tryBeginUpdate(projectId);
    expect(thirdRun.allowed).toBe(true);
  });

  it("handles numeric IDs correctly", () => {
    const result = tryBeginUpdate(123);

    expect(result.allowed).toBe(true);
    expect(result.key).toMatch(/^lock-123-\d+$/);

    // Concurrent attempt should be blocked
    const concurrent = tryBeginUpdate(123);
    expect(concurrent.allowed).toBe(false);
  });

  it("logs warning message when run is skipped", () => {
    tryBeginUpdate("project-1");
    tryBeginUpdate("project-1");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[duplicate-detection] Skipping update for project-1:"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Update already in progress since"),
    );
  });
});
