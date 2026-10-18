/**
 * Unit tests for src/lib/duplicate-detection.ts — cron job concurrency guard and bounded lock store.
 *
 * Verifies:
 * - Concurrent cron runs are prevented (second run is skipped with warning)
 * - Lock is released after successful completion or failure
 * - Opportunistic sweeps purge expired locks from unvisited project IDs
 * - Map size is strictly bounded by maxActiveLocks with oldest-lock eviction
 * - TTL and capacity thresholds, boundary conditions, and error recovery
 */

import {
  tryBeginUpdate,
  markCompleted,
  markFailed,
  setLockTTL,
  getLockTTL,
  getLockAge,
  sweepExpiredLocks,
  getActiveLocksCount,
  setMaxActiveLocks,
  getMaxActiveLocks,
  resetLocks,
  DEFAULT_MAX_ACTIVE_LOCKS,
} from "../lib/duplicate-detection";
import { logger } from "../lib/logger";

jest.mock("../lib/logger", () => ({
  logger: {
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("duplicate-detection (cron concurrency guard)", () => {
  beforeEach(() => {
    resetLocks();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetLocks();
  });

  // =========================================================================
  // Baseline Core Contracts (Original Regression Suite)
  // =========================================================================
  describe("Core locking and release contracts", () => {
    it("allows first update attempt for a given ID", () => {
      const result = tryBeginUpdate("project-1");

      expect(result.allowed).toBe(true);
      expect(result.key).toMatch(/^lock-project-1-\d+$/);
      expect(result.reason).toBe("");
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("skips concurrent update attempt with warning when lock is held", () => {
      tryBeginUpdate("project-1");
      const result = tryBeginUpdate("project-1");

      expect(result.allowed).toBe(false);
      expect(result.key).toBe("");
      expect(result.reason).toMatch(/Update already in progress since/);
      expect(logger.warn as jest.Mock).toHaveBeenCalledWith(
        expect.stringContaining("[duplicate-detection] Skipping update for project-1:"),
      );
    });

    it("allows update for different IDs concurrently", () => {
      const result1 = tryBeginUpdate("project-1");
      const result2 = tryBeginUpdate("project-2");

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
      expect(logger.warn as jest.Mock).not.toHaveBeenCalled();
    });

    it("releases lock after successful completion", () => {
      tryBeginUpdate("project-1");
      markCompleted("project-1");

      const result = tryBeginUpdate("project-1");
      expect(result.allowed).toBe(true);
      expect(logger.debug as jest.Mock).toHaveBeenCalledWith(
        "[duplicate-detection] Lock released for project-1 after successful completion",
      );
    });

    it("releases lock after failure", () => {
      tryBeginUpdate("project-1");
      markFailed("project-1");

      const result = tryBeginUpdate("project-1");
      expect(result.allowed).toBe(true);
      expect(logger.debug as jest.Mock).toHaveBeenCalledWith(
        "[duplicate-detection] Lock released for project-1 after failure",
      );
    });

    it("prevents concurrent runs with simulated concurrent execution", () => {
      const projectId = "concurrent-test";

      const firstRun = tryBeginUpdate(projectId);
      expect(firstRun.allowed).toBe(true);

      const secondRun = tryBeginUpdate(projectId);
      expect(secondRun.allowed).toBe(false);
      expect(secondRun.reason).toMatch(/Update already in progress/);
      expect(logger.warn as jest.Mock).toHaveBeenCalledTimes(1);

      markCompleted(projectId);

      const thirdRun = tryBeginUpdate(projectId);
      expect(thirdRun.allowed).toBe(true);
    });

    it("handles numeric IDs correctly", () => {
      const result = tryBeginUpdate(123);

      expect(result.allowed).toBe(true);
      expect(result.key).toMatch(/^lock-123-\d+$/);

      const concurrent = tryBeginUpdate(123);
      expect(concurrent.allowed).toBe(false);
    });

    it("logs warning message when run is skipped", () => {
      tryBeginUpdate("project-1");
      tryBeginUpdate("project-1");

      expect(logger.warn as jest.Mock).toHaveBeenCalledWith(
        expect.stringContaining("[duplicate-detection] Skipping update for project-1:"),
      );
      expect(logger.warn as jest.Mock).toHaveBeenCalledWith(
        expect.stringContaining("Update already in progress since"),
      );
    });
  });

  // =========================================================================
  // Section 1: Boundary Checks, TTL Thresholds, and Identifier Formats
  // =========================================================================
  describe("Boundary checks, TTL thresholds, and identifier formats", () => {
    const validTTLTestCases = [1, 5, 10, 50, 100, 500, 1000, 5000, 60_000, 300_000, 86_400_000];
    it.each(validTTLTestCases)(
      "accepts valid positive TTL value %i ms and reflects in getLockTTL",
      (ttl) => {
        setLockTTL(ttl);
        expect(getLockTTL()).toBe(ttl);
      },
    );

    const invalidTTLTestCases = [0, -0.001, -1, -50, -500, -10000, -Infinity, NaN];
    it.each(invalidTTLTestCases)(
      "rejects non-positive or non-finite TTL value (%p) with descriptive error",
      (invalidTtl) => {
        expect(() => setLockTTL(invalidTtl)).toThrow("Lock TTL must be positive");
      },
    );

    const validCapacityCases = [
      1,
      2,
      3,
      5,
      10,
      50,
      100,
      500,
      1000,
      DEFAULT_MAX_ACTIVE_LOCKS,
      50_000,
    ];
    it.each(validCapacityCases)(
      "accepts valid capacity limit %i and updates getMaxActiveLocks",
      (limit) => {
        setMaxActiveLocks(limit);
        expect(getMaxActiveLocks()).toBe(limit);
      },
    );

    const invalidCapacityCases = [0, -0.5, -1, -5, -50, -100, -9999, -Infinity, NaN];
    it.each(invalidCapacityCases)(
      "rejects non-positive or non-finite capacity limit (%p) with error",
      (invalidLimit) => {
        expect(() => setMaxActiveLocks(invalidLimit)).toThrow("Max active locks must be positive");
      },
    );

    const diverseIdCases = [
      "alpha",
      "project-uuid-1234-5678",
      "p_with_underscores_and.dots",
      "special!@#$%^&*()",
      "   spaces   ",
      "unicode-⚡-solar",
      "hyphen-separated-project-id",
      "UPPERCASE_PROJECT",
      "MixedCase-Project_42",
      "long-project-identifier-with-extra-entropy-string-values-1234567890",
      "p-slash/not/a/path",
      'json-like-{"id":1}',
      "0",
      0,
      1,
      42,
      1000,
      -999,
      999999999,
      1e6,
    ];
    it.each(diverseIdCases)("accurately acquires, holds, and releases diverse ID %p", (id) => {
      const initial = tryBeginUpdate(id);
      expect(initial.allowed).toBe(true);
      expect(getActiveLocksCount()).toBe(1);

      const blocked = tryBeginUpdate(id);
      expect(blocked.allowed).toBe(false);

      markCompleted(id);
      expect(getActiveLocksCount()).toBe(0);

      const reacquired = tryBeginUpdate(id);
      expect(reacquired.allowed).toBe(true);
    });

    it("treats numeric 123 and string '123' as distinct map keys without collision", () => {
      const numRes = tryBeginUpdate(123);
      const strRes = tryBeginUpdate("123");

      expect(numRes.allowed).toBe(true);
      expect(strRes.allowed).toBe(true);
      expect(getActiveLocksCount()).toBe(2);

      markCompleted(123);
      expect(getActiveLocksCount()).toBe(1);

      const numAgain = tryBeginUpdate(123);
      expect(numAgain.allowed).toBe(true);

      const strBlocked = tryBeginUpdate("123");
      expect(strBlocked.allowed).toBe(false);
    });

    it("returns undefined for getLockAge when ID has no active lock", () => {
      expect(getLockAge("non-existent")).toBeUndefined();
      expect(getLockAge(99999)).toBeUndefined();
    });

    it("returns non-negative integer for getLockAge on currently held lock", () => {
      tryBeginUpdate("aged-lock");
      const age = getLockAge("aged-lock");
      expect(typeof age).toBe("number");
      expect(age).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // Section 2: Combinatorial Lifecycle Transitions and Interleaved Runs
  // =========================================================================
  describe("Combinatorial lifecycle transitions and interleaved acquisitions", () => {
    const lifecycleSequences = [
      ["acquire", "complete", "acquire"],
      ["acquire", "fail", "acquire"],
      ["acquire", "acquire-blocked", "complete", "acquire"],
      ["acquire", "acquire-blocked", "fail", "acquire"],
      ["acquire", "complete", "complete", "acquire"],
      ["acquire", "fail", "fail", "acquire"],
    ];

    it.each(lifecycleSequences)(
      "reliably processes sequential state transitions: %j",
      (...steps) => {
        const id = "lifecycle-project";
        for (const step of steps) {
          if (step === "acquire") {
            const res = tryBeginUpdate(id);
            expect(res.allowed).toBe(true);
          } else if (step === "acquire-blocked") {
            const res = tryBeginUpdate(id);
            expect(res.allowed).toBe(false);
          } else if (step === "complete") {
            markCompleted(id);
          } else if (step === "fail") {
            markFailed(id);
          }
        }
      },
    );

    it("handles multiple interleaved projects concurrently without cross-talk", () => {
      const projectIds = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];

      // Acquire all
      for (const id of projectIds) {
        expect(tryBeginUpdate(id).allowed).toBe(true);
      }
      expect(getActiveLocksCount()).toBe(projectIds.length);

      // Verify all blocked
      for (const id of projectIds) {
        expect(tryBeginUpdate(id).allowed).toBe(false);
      }

      // Complete even indices, fail odd indices
      projectIds.forEach((id, index) => {
        if (index % 2 === 0) {
          markCompleted(id);
        } else {
          markFailed(id);
        }
      });
      expect(getActiveLocksCount()).toBe(0);

      // Verify all can be re-acquired
      for (const id of projectIds) {
        expect(tryBeginUpdate(id).allowed).toBe(true);
      }
    });
  });

  // =========================================================================
  // Section 3: Opportunistic Sweeps of Expired and Abandoned Locks
  // =========================================================================
  describe("Opportunistic expiration sweep across unvisited project locks", () => {
    it("sweepExpiredLocks returns 0 and leaves activeLocks intact when empty", () => {
      expect(sweepExpiredLocks()).toBe(0);
      expect(getActiveLocksCount()).toBe(0);
    });

    it("sweepExpiredLocks returns 0 when all active locks are within TTL", () => {
      setLockTTL(10_000);
      const now = Date.now();
      tryBeginUpdate("fresh-1");
      tryBeginUpdate("fresh-2");

      expect(sweepExpiredLocks(now + 100)).toBe(0);
      expect(getActiveLocksCount()).toBe(2);
    });

    it("reaps abandoned expired locks when an unrelated project begins an update", () => {
      setLockTTL(1_000);
      const now = 1_000_000;
      jest.spyOn(Date, "now").mockReturnValue(now);

      // Project A and B acquire locks
      expect(tryBeginUpdate("abandoned-A").allowed).toBe(true);
      expect(tryBeginUpdate("abandoned-B").allowed).toBe(true);
      expect(getActiveLocksCount()).toBe(2);

      // Advance time past TTL (abandoned-A and abandoned-B are never touched again)
      jest.spyOn(Date, "now").mockReturnValue(now + 1_500);

      // Project C initiates an update — triggers opportunistic sweep
      const cRes = tryBeginUpdate("active-C");
      expect(cRes.allowed).toBe(true);

      // Abandoned locks must have been purged without calling tryBeginUpdate on A or B
      expect(getActiveLocksCount()).toBe(1);
      expect(getLockAge("abandoned-A")).toBeUndefined();
      expect(getLockAge("abandoned-B")).toBeUndefined();

      // Check logs for stale lock releases
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[duplicate-detection] Lock for abandoned-A expired"),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[duplicate-detection] Lock for abandoned-B expired"),
      );
    });

    const purgeRatios = [
      { total: 10, expired: 0 },
      { total: 10, expired: 3 },
      { total: 10, expired: 5 },
      { total: 10, expired: 7 },
      { total: 10, expired: 10 },
      { total: 20, expired: 0 },
      { total: 20, expired: 8 },
      { total: 20, expired: 20 },
    ];
    it.each(purgeRatios)(
      "accurately purges $expired out of $total locks during explicit sweep",
      ({ total, expired }) => {
        setLockTTL(5_000);
        const baseTime = 5_000_000;

        for (let i = 0; i < total; i++) {
          const creationTime = i < expired ? baseTime : baseTime + 1_000;
          jest.spyOn(Date, "now").mockReturnValue(creationTime);
          tryBeginUpdate(`proj-${i}`);
        }

        expect(getActiveLocksCount()).toBe(total);

        // Evaluation time: baseTime + 5_500 ms (so first 'expired' entries exceed 5000ms TTL,
        // while entries created at baseTime + 1_000 have age 4_500 < 5_000)
        const purged = sweepExpiredLocks(baseTime + 5_500);
        expect(purged).toBe(expired);
        expect(getActiveLocksCount()).toBe(total - expired);
      },
    );
  });

  // =========================================================================
  // Section 4: Negative Controls, Isolation, and Defensive Recovery
  // =========================================================================
  describe("Negative controls, error handling, and lock isolation", () => {
    it("markCompleted on an unheld project ID is safe and causes 0 side-effects", () => {
      tryBeginUpdate("held-project");
      expect(getActiveLocksCount()).toBe(1);

      markCompleted("never-held-project");
      expect(getActiveLocksCount()).toBe(1);

      // Original lock remains blocked
      expect(tryBeginUpdate("held-project").allowed).toBe(false);
    });

    it("markFailed on an unheld project ID is safe and causes 0 side-effects", () => {
      tryBeginUpdate("held-project");
      expect(getActiveLocksCount()).toBe(1);

      markFailed("never-held-project");
      expect(getActiveLocksCount()).toBe(1);

      expect(tryBeginUpdate("held-project").allowed).toBe(false);
    });

    it("blocked acquisition attempt does not refresh or alter original lock timestamp", () => {
      setLockTTL(10_000);
      const t0 = 1_000_000;
      jest.spyOn(Date, "now").mockReturnValue(t0);

      tryBeginUpdate("stable-lock");
      expect(getLockAge("stable-lock")).toBe(0);

      // Attempt acquisition at t0 + 4000
      jest.spyOn(Date, "now").mockReturnValue(t0 + 4_000);
      const blocked = tryBeginUpdate("stable-lock");
      expect(blocked.allowed).toBe(false);

      // Age should still measure against original timestamp t0
      expect(getLockAge("stable-lock")).toBe(4_000);
    });

    it("setLockTTL error does not alter active lock TTL setting", () => {
      setLockTTL(4_500);
      expect(getLockTTL()).toBe(4_500);

      expect(() => setLockTTL(-100)).toThrow();
      expect(getLockTTL()).toBe(4_500);
    });

    it("setMaxActiveLocks error does not alter existing capacity setting", () => {
      setMaxActiveLocks(25);
      expect(getMaxActiveLocks()).toBe(25);

      expect(() => setMaxActiveLocks(0)).toThrow();
      expect(getMaxActiveLocks()).toBe(25);
    });
  });

  // =========================================================================
  // Section 5: Capacity Limiting, Eviction of Oldest Locks, and Stress Testing
  // =========================================================================
  describe("Capacity bounding, oldest lock eviction, and stress execution", () => {
    it("strictly bounds activeLocks size and evicts the oldest lock when full", () => {
      setMaxActiveLocks(3);
      setLockTTL(60_000); // Locks won't expire naturally

      const t0 = 2_000_000;
      jest.spyOn(Date, "now").mockReturnValue(t0);
      tryBeginUpdate("first-oldest");

      jest.spyOn(Date, "now").mockReturnValue(t0 + 100);
      tryBeginUpdate("second");

      jest.spyOn(Date, "now").mockReturnValue(t0 + 200);
      tryBeginUpdate("third");

      expect(getActiveLocksCount()).toBe(3);

      // Acquire 4th lock — must evict 'first-oldest'
      jest.spyOn(Date, "now").mockReturnValue(t0 + 300);
      const fourth = tryBeginUpdate("fourth-newest");
      expect(fourth.allowed).toBe(true);

      // Size must remain clamped at 3
      expect(getActiveLocksCount()).toBe(3);

      // 'first-oldest' was evicted, so it can now be acquired as a fresh lock
      expect(getLockAge("first-oldest")).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "activeLocks capacity limit (3) reached; evicting oldest lock for first-oldest",
        ),
      );

      // 'second', 'third', and 'fourth-newest' are still held
      expect(tryBeginUpdate("second").allowed).toBe(false);
      expect(tryBeginUpdate("third").allowed).toBe(false);
      expect(tryBeginUpdate("fourth-newest").allowed).toBe(false);
    });

    it("prefers opportunistic sweep over oldest-lock eviction when expired locks exist", () => {
      setMaxActiveLocks(2);
      setLockTTL(1_000);

      const t0 = 10_000_000;
      jest.spyOn(Date, "now").mockReturnValue(t0);
      tryBeginUpdate("proj-expired");

      jest.spyOn(Date, "now").mockReturnValue(t0 + 500);
      tryBeginUpdate("proj-fresh");

      // Advance time so proj-expired is expired (age 1500 > 1000) but proj-fresh is still valid (age 1000 == 1000 is expired, age 800 is valid)
      jest.spyOn(Date, "now").mockReturnValue(t0 + 1_200);

      // proj-fresh is age 700ms (still within 1000ms TTL)
      // proj-expired is age 1200ms (expired)
      // New update should clean proj-expired via sweep, avoiding forced eviction of proj-fresh
      const res = tryBeginUpdate("proj-new");
      expect(res.allowed).toBe(true);
      expect(getActiveLocksCount()).toBe(2);

      // proj-fresh was NOT evicted because opportunistic sweep freed a slot
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("activeLocks capacity limit (2) reached"),
      );
      expect(tryBeginUpdate("proj-fresh").allowed).toBe(false);
    });

    const stressBatchSizes = [5, 10, 15, 20, 25, 35, 50, 75, 100, 150];
    it.each(stressBatchSizes)(
      "endures high-frequency burst of %i sequential lock/unlock cycles without leaks",
      (iterations) => {
        for (let i = 0; i < iterations; i++) {
          const id = `stress-${i}`;
          expect(tryBeginUpdate(id).allowed).toBe(true);
          expect(tryBeginUpdate(id).allowed).toBe(false);
          markCompleted(id);
          expect(tryBeginUpdate(id).allowed).toBe(true);
          markFailed(id);
        }
        expect(getActiveLocksCount()).toBe(0);
      },
    );

    it("maintains strict bounded size under 150 rapid concurrent insertions with capacity cap 15", () => {
      const CAP = 15;
      setMaxActiveLocks(CAP);
      setLockTTL(100_000);

      for (let i = 0; i < 150; i++) {
        const res = tryBeginUpdate(`flood-${i}`);
        expect(res.allowed).toBe(true);
        expect(getActiveLocksCount()).toBeLessThanOrEqual(CAP);
      }
      expect(getActiveLocksCount()).toBe(CAP);
    });

    it("resetLocks clears all locks and restores default TTL and capacity configuration", () => {
      setLockTTL(42_000);
      setMaxActiveLocks(7);
      tryBeginUpdate("temp-1");
      tryBeginUpdate("temp-2");
      expect(getActiveLocksCount()).toBe(2);

      resetLocks();

      expect(getActiveLocksCount()).toBe(0);
      expect(getLockTTL()).toBe(5 * 60 * 1000);
      expect(getMaxActiveLocks()).toBe(DEFAULT_MAX_ACTIVE_LOCKS);
    });

    const lockAgeIntervals = [0, 50, 100, 250, 500, 1000, 2500, 5000];
    it.each(lockAgeIntervals)(
      "getLockAge accurately reports elapsed duration of %i ms",
      (elapsedMs) => {
        const t0 = 10_000_000;
        jest.spyOn(Date, "now").mockReturnValue(t0);
        tryBeginUpdate("age-test");

        jest.spyOn(Date, "now").mockReturnValue(t0 + elapsedMs);
        expect(getLockAge("age-test")).toBe(elapsedMs);
      },
    );

    it("verifies sequential FIFO eviction order under constrained capacity", () => {
      setMaxActiveLocks(3);
      setLockTTL(60_000);
      const t0 = 50_000_000;

      ["P1", "P2", "P3"].forEach((id, idx) => {
        jest.spyOn(Date, "now").mockReturnValue(t0 + idx * 10);
        tryBeginUpdate(id);
      });
      expect(getActiveLocksCount()).toBe(3);

      // Add P4: evicts P1
      jest.spyOn(Date, "now").mockReturnValue(t0 + 100);
      tryBeginUpdate("P4");
      expect(getLockAge("P1")).toBeUndefined();
      expect(getLockAge("P2")).toBeDefined();
      expect(getLockAge("P3")).toBeDefined();
      expect(getLockAge("P4")).toBeDefined();

      // Add P5: evicts P2
      jest.spyOn(Date, "now").mockReturnValue(t0 + 200);
      tryBeginUpdate("P5");
      expect(getLockAge("P2")).toBeUndefined();
      expect(getLockAge("P3")).toBeDefined();
      expect(getLockAge("P4")).toBeDefined();
      expect(getLockAge("P5")).toBeDefined();
    });

    it("produces deterministic unique key formats with timestamp matching Date.now", () => {
      const fixedTime = 1234567890;
      jest.spyOn(Date, "now").mockReturnValue(fixedTime);

      const res = tryBeginUpdate("formatted-project");
      expect(res.allowed).toBe(true);
      expect(res.key).toBe(`lock-formatted-project-${fixedTime}`);
    });
  });
});
