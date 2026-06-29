import {
  isErrorRateLimited,
  resetErrorRateLimit,
  clearAllRateLimits,
} from "../lib/error-limiter";

beforeEach(() => {
  clearAllRateLimits();
});

describe("isErrorRateLimited", () => {
  it("should not rate-limit the first error for a key", () => {
    expect(isErrorRateLimited("cron:project-1")).toBe(false);
  });

  it("should not rate-limit within maxErrors threshold", () => {
    expect(isErrorRateLimited("cron:project-1", 3, 60_000)).toBe(false);
    expect(isErrorRateLimited("cron:project-1", 3, 60_000)).toBe(false);
    expect(isErrorRateLimited("cron:project-1", 3, 60_000)).toBe(false);
  });

  it("should rate-limit after exceeding maxErrors", () => {
    expect(isErrorRateLimited("test-key", 2, 60_000)).toBe(false);
    expect(isErrorRateLimited("test-key", 2, 60_000)).toBe(false);
    expect(isErrorRateLimited("test-key", 2, 60_000)).toBe(true);
  });

  it("should reset after the window expires", async () => {
    expect(isErrorRateLimited("test-key", 2, 50)).toBe(false);
    expect(isErrorRateLimited("test-key", 2, 50)).toBe(false);
    expect(isErrorRateLimited("test-key", 2, 50)).toBe(true);

    await new Promise((r) => setTimeout(r, 60));

    expect(isErrorRateLimited("test-key", 2, 50)).toBe(false);
  });

  it("should treat different keys independently", () => {
    expect(isErrorRateLimited("key-a", 1, 60_000)).toBe(false);
    expect(isErrorRateLimited("key-a", 1, 60_000)).toBe(true);
    expect(isErrorRateLimited("key-b", 1, 60_000)).toBe(false);
  });
});

describe("resetErrorRateLimit", () => {
  it("should reset the rate limit for a specific key", () => {
    expect(isErrorRateLimited("reset-key", 1, 60_000)).toBe(false);
    expect(isErrorRateLimited("reset-key", 1, 60_000)).toBe(true);

    resetErrorRateLimit("reset-key");

    expect(isErrorRateLimited("reset-key", 1, 60_000)).toBe(false);
  });
});

describe("clearAllRateLimits", () => {
  it("should reset all rate limits", () => {
    expect(isErrorRateLimited("key-a", 1, 60_000)).toBe(false);
    expect(isErrorRateLimited("key-a", 1, 60_000)).toBe(true);
    expect(isErrorRateLimited("key-b", 1, 60_000)).toBe(false);
    expect(isErrorRateLimited("key-b", 1, 60_000)).toBe(true);

    clearAllRateLimits();

    expect(isErrorRateLimited("key-a", 1, 60_000)).toBe(false);
    expect(isErrorRateLimited("key-b", 1, 60_000)).toBe(false);
  });
});
