/**
 * Ordered graceful-shutdown sequence (#693).
 *
 * Rationale: stop producing work first (cron scheduling and other background
 * timers), let work that is already in flight finish, then drain/close the
 * resources that work depends on (HTTP, RPC, gRPC) and finally exit.
 *
 * Draining HTTP before stopping cron is a race: an in-flight HTTP request can
 * trigger (or overlap with) a cron run, so the scheduler must be silenced
 * before we start closing the resources cron jobs use.
 *
 * The steps are executed strictly in order and are injectable so the ordering
 * can be unit-tested without spawning a process. The whole sequence is expected
 * to be wrapped in the caller's `SHUTDOWN_TIMEOUT_MS` race so a wedged drain
 * cannot hang shutdown indefinitely.
 */

export interface ShutdownStep {
  name: string;
  run: () => void | Promise<void>;
}

export interface ShutdownDependencies {
  /** Stop every scheduler so no new cron run is produced. */
  stopCronScheduling: () => void | Promise<void>;
  /** Wait for cron runs that already started to settle. */
  awaitInFlightCron: () => Promise<void>;
  /** Stop producing background work (e.g. secret rotation timer). */
  stopBackgroundTimers: () => void | Promise<void>;
  /** Stop accepting new HTTP connections and drain in-flight requests. */
  closeHttpServer: () => Promise<void>;
  /** Drain the Stellar RPC connection pool. */
  drainRpc: () => Promise<void>;
  /** Gracefully stop the gRPC server, letting streams drain. */
  drainGrpc: () => Promise<void>;
  /** Terminate the process with the given exit code. */
  exit: (code: number) => void;
}

/**
 * Build the shutdown steps in the required order:
 *   stop cron → await in-flight cron → stop background timers →
 *   drain HTTP → drain RPC → drain gRPC → exit
 */
export function createShutdownSteps(deps: ShutdownDependencies): ShutdownStep[] {
  return [
    { name: "stop cron scheduling", run: deps.stopCronScheduling },
    { name: "await in-flight cron jobs", run: deps.awaitInFlightCron },
    { name: "stop background timers", run: deps.stopBackgroundTimers },
    { name: "drain HTTP server", run: deps.closeHttpServer },
    { name: "drain RPC connection pool", run: deps.drainRpc },
    { name: "drain gRPC server", run: deps.drainGrpc },
    { name: "exit", run: () => deps.exit(0) },
  ];
}

/** Run each step in order, awaiting it before starting the next. */
export async function runShutdownSequence(steps: ShutdownStep[]): Promise<void> {
  for (const step of steps) {
    await step.run();
  }
}

export interface CronRunTracker {
  /** Wrap a cron handler so its returned promise is tracked while it runs. */
  wrap: (fn: () => void | Promise<void>) => () => Promise<void>;
  /** Wait until no tracked cron run remains in flight. */
  drain: () => Promise<void>;
  /** Number of cron runs currently in flight. */
  pending: () => number;
}

/**
 * Track in-flight cron runs.
 *
 * node-cron's `ScheduledTask.stop()` only silences future ticks; it does not
 * expose a promise for an execution already in progress. This tracker records
 * the promise returned by each handler so `drain()` can await every one of
 * them. The stored promise never rejects (node-cron's runner owns error
 * reporting), which avoids unhandled-rejection noise on the tracking branch.
 */
export function createCronRunTracker(): CronRunTracker {
  const inFlight = new Set<Promise<unknown>>();

  return {
    wrap(fn) {
      return () => {
        const run = Promise.resolve().then(fn);
        const tracked = run.then(
          () => {
            inFlight.delete(tracked);
          },
          () => {
            inFlight.delete(tracked);
          },
        );
        inFlight.add(tracked);
        return run;
      };
    },
    async drain() {
      // Loop because a tick queued just before `stop()` could still start after
      // the first snapshot; the caller's timeout bounds this.
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    pending() {
      return inFlight.size;
    },
  };
}
