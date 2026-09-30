import {
  createCronRunTracker,
  createShutdownSteps,
  runShutdownSequence,
  ShutdownDependencies,
  ShutdownStep,
} from "../lib/shutdown";

function makeDeps(overrides: Partial<ShutdownDependencies> = {}): {
  deps: ShutdownDependencies;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: ShutdownDependencies = {
    stopCronScheduling: jest.fn(() => {
      calls.push("stop-cron");
    }),
    awaitInFlightCron: jest.fn(async () => {
      calls.push("await-in-flight-cron");
    }),
    stopBackgroundTimers: jest.fn(() => {
      calls.push("stop-background-timers");
    }),
    closeHttpServer: jest.fn(async () => {
      calls.push("drain-http");
    }),
    drainRpc: jest.fn(async () => {
      calls.push("drain-rpc");
    }),
    drainGrpc: jest.fn(async () => {
      calls.push("drain-grpc");
    }),
    exit: jest.fn((code: number) => {
      calls.push(`exit:${code}`);
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("graceful shutdown ordering (#693)", () => {
  it("stops cron before draining HTTP/RPC/gRPC and exits last", async () => {
    const { deps, calls } = makeDeps();

    await runShutdownSequence(createShutdownSteps(deps));

    expect(calls).toEqual([
      "stop-cron",
      "await-in-flight-cron",
      "stop-background-timers",
      "drain-http",
      "drain-rpc",
      "drain-grpc",
      "exit:0",
    ]);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("stops cron before the HTTP server is closed", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      stopCronScheduling: jest.fn(() => {
        order.push("stop-cron");
      }),
      closeHttpServer: jest.fn(async () => {
        order.push("close-http");
      }),
    });

    await runShutdownSequence(createShutdownSteps(deps));

    expect(order.indexOf("stop-cron")).toBeLessThan(order.indexOf("close-http"));
  });

  it("awaits each step before starting the next", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const steps: ShutdownStep[] = [
      {
        name: "first",
        run: async () => {
          order.push("first-start");
          await gate;
          order.push("first-end");
        },
      },
      {
        name: "second",
        run: () => {
          order.push("second");
        },
      },
    ];

    const sequence = runShutdownSequence(steps);
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);

    release();
    await sequence;
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("propagates a step failure so the caller can force-exit", async () => {
    const { deps } = makeDeps({
      drainRpc: jest.fn(async () => {
        throw new Error("pool drain failed");
      }),
    });

    await expect(runShutdownSequence(createShutdownSteps(deps))).rejects.toThrow(
      "pool drain failed",
    );
    expect(deps.exit).not.toHaveBeenCalled();
  });
});

describe("cron run tracking (#693)", () => {
  it("drains in-flight cron runs and waits for them to settle", async () => {
    const tracker = createCronRunTracker();
    const finished: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const wrapped = tracker.wrap(async () => {
      await gate;
      finished.push(1);
    });

    const run = wrapped();
    expect(tracker.pending()).toBe(1);

    const drained = tracker.drain();
    expect(finished).toEqual([]);

    release();
    await drained;
    await run;

    expect(finished).toEqual([1]);
    expect(tracker.pending()).toBe(0);
  });

  it("does not leak runs that reject and resolves drain", async () => {
    const tracker = createCronRunTracker();
    const wrapped = tracker.wrap(async () => {
      throw new Error("cron boom");
    });

    const run = wrapped();
    await expect(run).rejects.toThrow("cron boom");
    await expect(tracker.drain()).resolves.toBeUndefined();
    expect(tracker.pending()).toBe(0);
  });

  it("drain resolves immediately when nothing is running", async () => {
    const tracker = createCronRunTracker();
    await expect(tracker.drain()).resolves.toBeUndefined();
    expect(tracker.pending()).toBe(0);
  });
});
