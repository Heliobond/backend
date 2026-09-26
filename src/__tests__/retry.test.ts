jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    formatError: jest.fn((err: unknown) =>
      err instanceof Error
        ? { error_name: err.name, error_message: err.message }
        : { error: String(err) },
    ),
  },
}));

import { logger } from "../lib/logger";
import { backoffDelay, isTransientError, withRetry } from "../lib/retry";

const mockedLogger = logger as jest.Mocked<typeof logger>;

// ── isTransientError ──────────────────────────────────────────────────────────

describe("isTransientError", () => {
  it("returns true for generic network errors", () => {
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });

  it("returns false for tx_bad_auth", () => {
    expect(isTransientError(new Error("tx_bad_auth"))).toBe(false);
  });

  it("returns false for tx_insufficient_balance", () => {
    expect(isTransientError(new Error("tx_insufficient_balance"))).toBe(false);
  });

  it("returns false for tx_no_account", () => {
    expect(isTransientError(new Error("tx_no_account"))).toBe(false);
  });

  it("returns false for tx_insufficient_fee", () => {
    expect(isTransientError(new Error("tx_insufficient_fee"))).toBe(false);
  });

  it("returns false for contract_error", () => {
    expect(isTransientError(new Error("contract_error: revert"))).toBe(false);
  });

  it("returns false for ADMIN_SECRET_KEY not set", () => {
    expect(isTransientError(new Error("ADMIN_SECRET_KEY not set"))).toBe(false);
  });

  it("treats non-Error values as transient (no permanent keyword)", () => {
    expect(isTransientError("timeout")).toBe(true);
    expect(isTransientError(500)).toBe(true);
  });

  // ── HTTP-style classification (transient vs permanent) ──────────────────────

  it("returns true for a timeout error", () => {
    expect(isTransientError(new Error("timeout of 5000ms exceeded"))).toBe(true);
  });

  it("returns true for a 503 (service unavailable)", () => {
    expect(isTransientError(new Error("request failed with status code 503"))).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
  });

  it("returns true for a generic network error", () => {
    expect(isTransientError(new Error("network error"))).toBe(true);
    expect(isTransientError(new Error("ECONNREFUSED"))).toBe(true);
  });

  it("returns false for a 400 (bad request)", () => {
    expect(isTransientError(new Error("request failed with status code 400"))).toBe(false);
    expect(isTransientError({ status: 400 })).toBe(false);
  });

  it("returns false for a 422 (unprocessable entity)", () => {
    expect(isTransientError(new Error("request failed with status code 422"))).toBe(false);
    expect(isTransientError({ status: 422 })).toBe(false);
  });

  it("returns false for a 404 (not found)", () => {
    expect(isTransientError(new Error("request failed with status code 404"))).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
  });

  it("reads status off statusCode and response.status too", () => {
    expect(isTransientError({ statusCode: 400 })).toBe(false);
    expect(isTransientError({ response: { status: 404 } })).toBe(false);
  });
});

// ── backoffDelay ──────────────────────────────────────────────────────────────

describe("backoffDelay", () => {
  const cfg = {
    maxAttempts: 4,
    baseDelayMs: 200,
    maxDelayMs: 30_000,
    jitter: 0, // zero jitter → deterministic
    label: "test",
  };

  it("returns baseDelayMs on attempt 0 (first retry) when jitter is 0", () => {
    expect(backoffDelay(0, cfg)).toBe(200);
  });

  it("doubles the delay for each subsequent attempt", () => {
    expect(backoffDelay(1, cfg)).toBe(400);
    expect(backoffDelay(2, cfg)).toBe(800);
    expect(backoffDelay(3, cfg)).toBe(1_600);
  });

  it("caps delay at maxDelayMs", () => {
    expect(backoffDelay(20, cfg)).toBe(30_000);
  });

  it("applies jitter: result stays within the expected ± band", () => {
    const jitterCfg = { ...cfg, jitter: 0.3 };
    const delay = backoffDelay(0, jitterCfg); // exponential = 200
    expect(delay).toBeGreaterThanOrEqual(Math.floor(200 * 0.7));
    expect(delay).toBeLessThanOrEqual(Math.ceil(200 * 1.3));
  });

  it("always returns a non-negative integer", () => {
    for (let i = 0; i < 10; i++) {
      const d = backoffDelay(i, { ...cfg, jitter: 0.3 });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(d)).toBe(true);
    }
  });
});

// ── withRetry ─────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it("resolves immediately when fn succeeds on the first attempt", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const p = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, jitter: 0 });
    await jest.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockedLogger.info).not.toHaveBeenCalled();
    expect(mockedLogger.warn).not.toHaveBeenCalled();
  });

  it("retries on transient errors and resolves when fn eventually succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("recovered");

    const p = withRetry(fn, { maxAttempts: 4, baseDelayMs: 10, jitter: 0 });
    await jest.runAllTimersAsync();
    await expect(p).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(mockedLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockedLogger.warn).toHaveBeenNthCalledWith(
      1,
      "[retry] attempt 1/4 failed; retrying",
      expect.objectContaining({
        attempt: 1,
        delayMs: 10,
        error_message: "timeout",
        label: "retry",
        maxAttempts: 4,
      }),
    );
    expect(mockedLogger.info).toHaveBeenCalledWith(
      "[retry] succeeded on attempt 3",
      expect.objectContaining({ attempt: 3, label: "retry", maxAttempts: 4 }),
    );
  });

  it("throws immediately on a permanent error without retrying", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("tx_bad_auth"));
    const p = withRetry(fn, { maxAttempts: 4, baseDelayMs: 10, jitter: 0 });
    await Promise.all([expect(p).rejects.toThrow("tx_bad_auth"), jest.runAllTimersAsync()]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "[retry] permanent error, not retrying",
      expect.objectContaining({
        attempt: 1,
        error_message: "tx_bad_auth",
        label: "retry",
        maxAttempts: 4,
      }),
    );
  });

  it("exhausts all attempts and re-throws when fn always fails transiently", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    const p = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, jitter: 0 });
    await Promise.all([expect(p).rejects.toThrow("ECONNRESET"), jest.runAllTimersAsync()]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects maxAttempts=1 — no retries at all", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("timeout"));
    const p = withRetry(fn, { maxAttempts: 1, baseDelayMs: 10, jitter: 0 });
    await Promise.all([expect(p).rejects.toThrow("timeout"), jest.runAllTimersAsync()]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ── Acceptance criteria ──────────────────────────────────────────────────────

  it("timeout → retries", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("timeout of 5000ms exceeded"))
      .mockResolvedValue("ok");
    const p = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, jitter: 0 });
    await jest.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("503 → retries", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce({ status: 503, message: "Service Unavailable" })
      .mockResolvedValue("ok");
    const p = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, jitter: 0 });
    await jest.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("400 → no retry", async () => {
    const fn = jest.fn().mockRejectedValue({ status: 400, message: "Bad Request" });
    const p = withRetry(fn, { maxAttempts: 4, baseDelayMs: 10, jitter: 0 });
    await Promise.all([expect(p).rejects.toMatchObject({ status: 400 }), jest.runAllTimersAsync()]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("max retries exceeded → failure", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("timeout"));
    const p = withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, jitter: 0 });
    await Promise.all([expect(p).rejects.toThrow("timeout"), jest.runAllTimersAsync()]);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("uses exponential intervals between retries (base retry 1 = baseDelayMs)", async () => {
    const delays: number[] = [];

    jest.useRealTimers();
    const spy = jest
      .spyOn(global, "setTimeout")
      .mockImplementation((cb: (...args: unknown[]) => void, ms?: number) => {
        delays.push(ms ?? 0);
        (cb as () => void)();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("ok");

    await withRetry(fn, { maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 30_000, jitter: 0 });

    expect(delays[0]).toBe(200); // attempt 0 → 200ms
    expect(delays[1]).toBe(400); // attempt 1 → 400ms

    spy.mockRestore();
  });
});
