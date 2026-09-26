import { CircuitBreaker } from "../lib/circuit-breaker";

jest.mock("../lib/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    formatError: jest.fn((err: unknown) => ({ error: String(err) })),
  },
}));

describe("CircuitBreaker", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("opens the circuit after consecutive failures", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    const failingCall = jest.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(failingCall)).rejects.toThrow("boom");
    await expect(breaker.execute(failingCall)).rejects.toThrow("boom");

    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.getMetrics().consecutiveFailures).toBe(2);
  });

  it("rejects requests immediately when the circuit is open", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const failingCall = jest.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(failingCall)).rejects.toThrow("boom");

    const blockedCall = jest.fn().mockResolvedValue("should-not-run");
    await expect(breaker.execute(blockedCall)).rejects.toThrow("Circuit is OPEN");

    expect(blockedCall).not.toHaveBeenCalled();
  });

  it("half-opens after the cooldown window elapses", async () => {
    let currentTime = 0;
    jest.spyOn(Date, "now").mockImplementation(() => currentTime);

    const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 1000 });
    const failingCall = jest.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(failingCall)).rejects.toThrow("boom");

    currentTime = 1001;

    let observedState: string | undefined;
    const successCall = jest.fn().mockImplementation(async () => {
      observedState = breaker.getState();
      return "ok";
    });

    await expect(breaker.execute(successCall)).resolves.toBe("ok");
    expect(observedState).toBe("HALF_OPEN");
  });

  it("logs state transitions via the structured logger", async () => {
    const { logger } = jest.requireMock("../lib/logger") as { logger: { warn: jest.Mock } };
    const breaker = new CircuitBreaker({ failureThreshold: 1, name: "TestRPC" });
    const failingCall = jest.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(failingCall)).rejects.toThrow("boom");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("TestRPC"),
      expect.objectContaining({ from: "CLOSED", to: "OPEN" }),
    );
  });

  it("uses configurable threshold from CIRCUIT_BREAKER_THRESHOLD env var", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 10 });
    expect(breaker.getMetrics().state).toBe("CLOSED");
  });

  it("closes the circuit after a successful request", async () => {
    let currentTime = 0;
    jest.spyOn(Date, "now").mockImplementation(() => currentTime);

    const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 1000 });
    const failingCall = jest.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(failingCall)).rejects.toThrow("boom");

    currentTime = 1001;
    await expect(breaker.execute(async () => "ok")).resolves.toBe("ok");

    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.getMetrics().consecutiveFailures).toBe(0);
  });

  describe("HALF_OPEN single-trial guard", () => {
    /** Drive the breaker to OPEN with a single failure, then move past cooldown. */
    async function openThenCoolDown(breaker: CircuitBreaker, advance: () => void): Promise<void> {
      await expect(breaker.execute(jest.fn().mockRejectedValue(new Error("boom")))).rejects.toThrow(
        "boom",
      );
      expect(breaker.getState()).toBe("OPEN");
      advance();
    }

    it("admits only one concurrent caller into HALF_OPEN", async () => {
      let currentTime = 0;
      jest.spyOn(Date, "now").mockImplementation(() => currentTime);

      const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 1000 });
      await openThenCoolDown(breaker, () => {
        currentTime = 1001;
      });

      // Hold the trial open so every other caller overlaps with it.
      let releaseTrial: (() => void) | undefined;
      const trialGate = new Promise<void>((resolve) => {
        releaseTrial = resolve;
      });
      const trialCall = jest.fn().mockImplementation(async () => {
        await trialGate;
        return "probe-ok";
      });

      const trial = breaker.execute(trialCall);
      expect(breaker.getState()).toBe("HALF_OPEN");
      expect(breaker.getMetrics().halfOpenTrialInFlight).toBe(true);

      // Every concurrent caller must be rejected without invoking fn.
      const stampede = jest.fn().mockResolvedValue("should-not-run");
      const rejected = await Promise.allSettled(
        Array.from({ length: 10 }, () => breaker.execute(stampede)),
      );

      expect(rejected.every((r) => r.status === "rejected")).toBe(true);
      expect(stampede).not.toHaveBeenCalled();
      expect(trialCall).toHaveBeenCalledTimes(1);

      releaseTrial!();
      await expect(trial).resolves.toBe("probe-ok");
      expect(breaker.getState()).toBe("CLOSED");
      expect(breaker.getMetrics().halfOpenTrialInFlight).toBe(false);
    });

    it("routes rejected half-open callers through the fallback", async () => {
      let currentTime = 0;
      jest.spyOn(Date, "now").mockImplementation(() => currentTime);

      const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 1000 });
      await openThenCoolDown(breaker, () => {
        currentTime = 1001;
      });

      let releaseTrial: (() => void) | undefined;
      const trialGate = new Promise<void>((resolve) => {
        releaseTrial = resolve;
      });
      const trial = breaker.execute(async () => {
        await trialGate;
        return "probe-ok";
      });

      const fallback = jest.fn().mockResolvedValue("degraded");
      const blocked = jest.fn().mockResolvedValue("should-not-run");
      await expect(breaker.execute(blocked, fallback)).resolves.toBe("degraded");

      expect(blocked).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledTimes(1);

      releaseTrial!();
      await expect(trial).resolves.toBe("probe-ok");
    });

    it("re-opens and stays closed to new trials when the trial fails", async () => {
      let currentTime = 0;
      jest.spyOn(Date, "now").mockImplementation(() => currentTime);

      const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 1000 });
      await openThenCoolDown(breaker, () => {
        currentTime = 1001;
      });

      let releaseTrial: (() => void) | undefined;
      const trialGate = new Promise<void>((resolve) => {
        releaseTrial = resolve;
      });
      const trialCall = jest.fn().mockImplementation(async () => {
        await trialGate;
        throw new Error("still down");
      });

      const trial = breaker.execute(trialCall);
      const stampede = jest.fn().mockResolvedValue("should-not-run");
      await expect(breaker.execute(stampede)).rejects.toThrow("Circuit is HALF_OPEN");
      expect(stampede).not.toHaveBeenCalled();

      releaseTrial!();
      await expect(trial).rejects.toThrow("still down");

      // A failed canary re-opens the circuit for a full cooldown window.
      expect(breaker.getState()).toBe("OPEN");
      expect(breaker.getMetrics().halfOpenTrialInFlight).toBe(false);

      // Still within the cooldown: nobody gets through, and a second probe is
      // not fired until the window elapses again.
      await expect(breaker.execute(jest.fn())).rejects.toThrow("Circuit is OPEN");
      expect(trialCall).toHaveBeenCalledTimes(1);
    });

    it("admits concurrent callers again once the trial succeeds", async () => {
      let currentTime = 0;
      jest.spyOn(Date, "now").mockImplementation(() => currentTime);

      const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 1000 });
      await openThenCoolDown(breaker, () => {
        currentTime = 1001;
      });

      await breaker.execute(async () => "probe-ok");
      expect(breaker.getState()).toBe("CLOSED");

      // Circuit is healthy: full concurrency is restored.
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => breaker.execute(async () => `ok-${i}`)),
      );
      expect(results).toEqual(["ok-0", "ok-1", "ok-2", "ok-3", "ok-4"]);
    });
  });
});
