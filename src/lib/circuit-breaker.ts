import { logger } from "./logger";

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  name?: string;
}

export interface BreakerMetrics {
  state: BreakerState;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  lastStateChange: number;
  halfOpenTrialInFlight: boolean;
}

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private lastFailureAt: number | null = null;
  private openedAt: number | null = null;
  private lastStateChange = Date.now();
  /**
   * True while the single HALF_OPEN trial request is executing. Guards the
   * canary probe: without it, every caller that observes HALF_OPEN (or that
   * trips the transition itself) would call through and stampede a downstream
   * that is only just recovering.
   */
  private halfOpenTrialInFlight = false;
  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      recoveryTimeoutMs: config.recoveryTimeoutMs ?? 30_000,
      name: config.name ?? "CircuitBreaker",
    };
  }

  /** Execute fn, applying circuit-breaker logic. Falls back to fallback() when OPEN. */
  async execute<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() - (this.openedAt ?? 0) < this.config.recoveryTimeoutMs) {
        return this.reject("OPEN", fallback);
      }
      // The cooldown elapsed: this caller is the one that moves the breaker to
      // HALF_OPEN and, below, gets to run the trial request.
      this.transition("HALF_OPEN");
    }

    // HALF_OPEN admits exactly one trial request. Callers that arrive while that
    // trial is still in flight are treated as if the circuit were still OPEN —
    // queued behind a single canary — so a just-recovered dependency is probed
    // once instead of being hit by a burst of concurrent requests.
    let ownsTrial = false;
    if (this.state === "HALF_OPEN") {
      if (this.halfOpenTrialInFlight) {
        return this.reject("HALF_OPEN", fallback);
      }
      this.halfOpenTrialInFlight = true;
      ownsTrial = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      if (fallback && this.state === "OPEN") return fallback();
      throw err;
    } finally {
      // Only the trial owner clears the flag, so a rejected caller can never
      // release a trial that is still running.
      if (ownsTrial) this.halfOpenTrialInFlight = false;
    }
  }

  /** Reject a call: delegate to fallback() when provided, otherwise throw. */
  private reject<T>(state: BreakerState, fallback?: () => Promise<T>): Promise<T> {
    if (fallback) return fallback();
    throw new Error(`[${this.config.name}] Circuit is ${state} – request rejected`);
  }

  private onSuccess(): void {
    this.totalSuccesses++;
    this.consecutiveFailures = 0;
    if (this.state === "HALF_OPEN") {
      this.transition("CLOSED");
    }
  }

  private onFailure(): void {
    this.totalFailures++;
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    if (
      this.state === "HALF_OPEN" ||
      (this.state === "CLOSED" && this.consecutiveFailures >= this.config.failureThreshold)
    ) {
      this.openedAt = Date.now();
      this.transition("OPEN");
    }
  }

  private transition(next: BreakerState): void {
    logger.warn(`[${this.config.name}] circuit state: ${this.state} → ${next}`, {
      from: this.state,
      to: next,
      consecutiveFailures: this.consecutiveFailures,
    });
    this.state = next;
    this.lastStateChange = Date.now();
  }

  getState(): BreakerState {
    return this.state;
  }

  getMetrics(): BreakerMetrics {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastFailureAt: this.lastFailureAt,
      openedAt: this.openedAt,
      lastStateChange: this.lastStateChange,
      halfOpenTrialInFlight: this.halfOpenTrialInFlight,
    };
  }

  /** Reset to CLOSED – useful for testing or manual recovery. */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.halfOpenTrialInFlight = false;
    this.lastStateChange = Date.now();
  }
}
