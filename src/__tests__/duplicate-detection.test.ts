import {
  tryBeginUpdate,
  markCompleted,
  markFailed,
  getStatus,
  clearState,
} from "../lib/duplicate-detection";

beforeEach(() => {
  clearState();
});

describe("tryBeginUpdate", () => {
  it("should allow first update for a project", () => {
    const result = tryBeginUpdate(1);

    expect(result.allowed).toBe(true);
    expect(result.key).toMatch(/^update_1_\d+_[a-z0-9]+$/);
    expect(result.status).toBe("in_flight");
  });

  it("should generate unique keys for different attempts", () => {
    const r1 = tryBeginUpdate(1);
    const r2 = tryBeginUpdate(2);

    expect(r1.key).not.toBe(r2.key);
  });

  it("should reject duplicate when project is in_flight", () => {
    tryBeginUpdate(1);

    const result = tryBeginUpdate(1, 3_600_000, 300_000);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("already in_flight");
  });

  it("should reject duplicate within dedup window after completed", () => {
    tryBeginUpdate(1);
    markCompleted(1);

    const result = tryBeginUpdate(1, 3_600_000);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Duplicate update");
    expect(result.reason).toContain("completed");
  });

  it("should reject duplicate within dedup window after failed", () => {
    tryBeginUpdate(1);
    markFailed(1);

    const result = tryBeginUpdate(1, 3_600_000);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("failed");
  });

  it("should allow retry after dedup window expires", async () => {
    tryBeginUpdate(1);
    markCompleted(1);

    const result = tryBeginUpdate(1, 0);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe("in_flight");
  });

  it("should allow retry after stale threshold for in_flight", () => {
    tryBeginUpdate(1);

    const result = tryBeginUpdate(1, 3_600_000, 0);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe("in_flight");
  });

  it("should handle multiple different projects independently", () => {
    const r1 = tryBeginUpdate(1);
    const r2 = tryBeginUpdate(2);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
  });

  it("should not affect other projects when one is completed", () => {
    tryBeginUpdate(1);
    tryBeginUpdate(2);
    markCompleted(1);

    const r1 = tryBeginUpdate(1, 3_600_000);
    expect(r1.allowed).toBe(false);

    const r2 = tryBeginUpdate(2);
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toContain("in_flight");
  });
});

describe("markCompleted", () => {
  it("should transition status to completed", () => {
    tryBeginUpdate(1);
    markCompleted(1);

    const state = getStatus(1);
    expect(state?.status).toBe("completed");
    expect(state?.key).toBeDefined();
  });

  it("should not throw when called without prior tryBeginUpdate", () => {
    expect(() => markCompleted(999)).not.toThrow();
  });
});

describe("markFailed", () => {
  it("should transition status to failed", () => {
    tryBeginUpdate(1);
    markFailed(1);

    const state = getStatus(1);
    expect(state?.status).toBe("failed");
  });

  it("should not throw when called without prior tryBeginUpdate", () => {
    expect(() => markFailed(999)).not.toThrow();
  });
});

describe("getStatus", () => {
  it("should return undefined for unknown project", () => {
    expect(getStatus(999)).toBeUndefined();
  });

  it("should return current state for known project", () => {
    tryBeginUpdate(42);
    const state = getStatus(42);

    expect(state).toBeDefined();
    expect(state!.key).toMatch(/^update_42_/);
    expect(state!.status).toBe("in_flight");
    expect(state!.startedAt).toBeGreaterThan(0);
  });
});

describe("clearState", () => {
  it("should clear all tracked state", () => {
    tryBeginUpdate(1);
    tryBeginUpdate(2);
    clearState();

    expect(getStatus(1)).toBeUndefined();
    expect(getStatus(2)).toBeUndefined();

    const r1 = tryBeginUpdate(1);
    expect(r1.allowed).toBe(true);
  });
});
