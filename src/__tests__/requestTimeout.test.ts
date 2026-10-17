import { EventEmitter } from "events";
import requestTimeout, {
  createRequestTimeout,
  parseTimeout,
  DEFAULT_TIMEOUT_MS,
} from "../middleware/requestTimeout";

interface MockReqOptions {
  path?: string;
  headers?: Record<string, string>;
}

function createMockReq(options: MockReqOptions = {}): any {
  const req = new EventEmitter() as any;
  req.path = options.path ?? "/";
  req.url = req.path;
  req.headers = options.headers ?? {};
  req.destroy = jest.fn();
  req.get = jest.fn((header: string) => req.headers[header.toLowerCase()]);
  return req;
}

function createMockRes(): any {
  const res = new EventEmitter() as any;
  res.headersSent = false;
  res.writableEnded = false;
  res.statusCode = 200;
  res.status = jest.fn(function (code: number) {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn(function (_data: any) {
    res.headersSent = true;
    res.writableEnded = true;
    return res;
  });
  res.send = jest.fn(function (_data: any) {
    res.headersSent = true;
    res.writableEnded = true;
    return res;
  });
  res.end = jest.fn(function () {
    res.headersSent = true;
    res.writableEnded = true;
    return res;
  });
  return res;
}

describe("requestTimeout Middleware - Comprehensive 5D Verification", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // =========================================================================
  // DIMENSION 1: Boundaries, Clamping & Parsing
  // =========================================================================
  describe("Dimension 1: Boundaries & parseTimeout Clamping", () => {
    const boundaryTestCases: Array<[string | undefined, number, number, string]> = [
      [undefined, 30000, 30000, "undefined returns fallback"],
      ["", 30000, 30000, "empty string returns fallback"],
      ["0", 30000, 30000, "zero returns fallback"],
      ["-1", 30000, 30000, "negative -1 returns fallback"],
      ["-9999", 30000, 30000, "negative -9999 returns fallback"],
      ["abc", 30000, 30000, "non-numeric string returns fallback"],
      ["NaN", 30000, 30000, "'NaN' string returns fallback"],
      ["Infinity", 30000, 30000, "'Infinity' string returns fallback"],
      ["null", 30000, 30000, "'null' string returns fallback"],
      ["undefined", 30000, 30000, "'undefined' string returns fallback"],
      ["1", 30000, 1, "minimum positive integer 1 is parsed"],
      ["500", 30000, 500, "500ms parsed correctly"],
      ["30000", 30000, 30000, "30000ms parsed correctly"],
      ["60000", 30000, 60000, "60000ms parsed correctly"],
      ["120000", 30000, 120000, "120000ms parsed correctly"],
      ["99999999", 30000, 99999999, "large number parsed correctly"],
      ["  45000  ", 30000, 45000, "padded numeric string parsed correctly"],
      ["5000ms", 30000, 5000, "leading numeric string parsed via parseInt"],
    ];

    test.each(boundaryTestCases)(
      "parseTimeout('%s', %d) => %d (%s)",
      (input, fallback, expected, _description) => {
        expect(parseTimeout(input, fallback)).toBe(expected);
      }
    );

    const pathBoundaries: Array<[string, boolean, string]> = [
      ["/admin", true, "exact /admin root"],
      ["/admin/vaults", true, "subpath /admin/vaults"],
      ["/admin/config/secrets", true, "deep admin path"],
      ["/api/admin", true, "exact /api/admin"],
      ["/api/admin/users", true, "subpath /api/admin/users"],
      ["/v1/admin", true, "/v1/admin path"],
      ["/v1/admin/health", true, "/v1/admin/health subpath"],
      ["/", false, "root path"],
      ["/api/v1/projects", false, "public projects API"],
      ["/vaults", false, "public vaults endpoint"],
      ["/health", false, "health check"],
      ["/users/admin", false, "/admin suffix is NOT admin prefix"],
      ["/administration", false, "/administration prefix is not /admin route unless path boundary"],
      ["/api/v1/metrics", false, "public metrics endpoint"],
      ["", false, "empty string path"],
    ];

    test.each(pathBoundaries)(
      "path '%s' route boundary detection (isAdmin = %s) - %s",
      (path, isAdmin, _desc) => {
        const middleware = createRequestTimeout({
          defaultTimeoutMs: 1000,
          adminTimeoutMs: 5000,
        });
        const req = createMockReq({ path });
        const res = createMockRes();
        const next = jest.fn();

        middleware(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);

        if (isAdmin) {
          // At 1500ms, should NOT have timed out yet
          jest.advanceTimersByTime(1500);
          expect(res.status).not.toHaveBeenCalledWith(408);
          // At 5000ms, should time out
          jest.advanceTimersByTime(3500);
          expect(res.status).toHaveBeenCalledWith(408);
        } else {
          // At 1000ms, should time out
          jest.advanceTimersByTime(1000);
          expect(res.status).toHaveBeenCalledWith(408);
        }
      }
    );
  });

  // =========================================================================
  // DIMENSION 2: Combinatorics of Early Disconnects and Endpoints
  // =========================================================================
  describe("Dimension 2: Combinatorics of Client Termination", () => {
    const disconnectScenarios = [
      { event: "res.close", target: "res", emitEvent: "close" },
      { event: "req.close", target: "req", emitEvent: "close" },
      { event: "req.error", target: "req", emitEvent: "error", arg: new Error("Socket error") },
    ];

    const endpointPaths = ["/api/vaults", "/admin/settings", "/v1/admin/audit"];

    endpointPaths.forEach((path) => {
      disconnectScenarios.forEach(({ event, target, emitEvent, arg }) => {
        it(`cancels pending timer and aborts signal on ${event} at path ${path}`, () => {
          const middleware = createRequestTimeout({
            defaultTimeoutMs: 2000,
            adminTimeoutMs: 4000,
          });
          const req = createMockReq({ path });
          const res = createMockRes();
          const next = jest.fn();

          middleware(req, res, next);
          expect(next).toHaveBeenCalledTimes(1);
          expect(req.signal.aborted).toBe(false);

          // Fast forward halfway through timeout window
          jest.advanceTimersByTime(1000);

          // Client disconnect occurs
          if (target === "res") {
            res.emit(emitEvent, arg);
          } else {
            req.emit(emitEvent, arg);
          }

          // Abort signal should immediately be aborted
          expect(req.signal.aborted).toBe(true);

          // Advance past full timeout duration
          jest.advanceTimersByTime(5000);

          // Timer must NOT fire 408 on dead socket
          expect(res.status).not.toHaveBeenCalledWith(408);
          expect(req.destroy).not.toHaveBeenCalled();
        });
      });
    });

    it("handles multiple rapid close events gracefully without double-abort error", () => {
      const middleware = createRequestTimeout({ defaultTimeoutMs: 1000 });
      const req = createMockReq();
      req.on("error", () => {});
      const res = createMockRes();
      middleware(req, res, jest.fn());

      expect(() => {
        res.emit("close");
        req.emit("close");
        req.emit("error", new Error("duplicate socket close"));
      }).not.toThrow();

      expect(req.signal.aborted).toBe(true);
    });
  });

  // =========================================================================
  // DIMENSION 3: AbortSignal & Downstream Integration
  // =========================================================================
  describe("Dimension 3: AbortSignal & Downstream Task Cancellation", () => {
    it("attaches both req.abortController and req.signal to incoming request", () => {
      const middleware = createRequestTimeout();
      const req = createMockReq();
      const res = createMockRes();
      middleware(req, res, jest.fn());

      expect(req.abortController).toBeDefined();
      expect(req.abortController).toBeInstanceOf(AbortController);
      expect(req.signal).toBeDefined();
      expect(req.signal.aborted).toBe(false);
    });

    it("triggers abort event listeners attached to req.signal when client disconnects", () => {
      const middleware = createRequestTimeout({ defaultTimeoutMs: 3000 });
      const req = createMockReq();
      const res = createMockRes();
      middleware(req, res, jest.fn());

      const onAbortListener = jest.fn();
      req.signal.addEventListener("abort", onAbortListener);

      res.emit("close");

      expect(onAbortListener).toHaveBeenCalledTimes(1);
      expect(req.signal.aborted).toBe(true);
    });

    it("triggers abort on req.signal when request times out", () => {
      const middleware = createRequestTimeout({ defaultTimeoutMs: 1000 });
      const req = createMockReq();
      const res = createMockRes();
      middleware(req, res, jest.fn());

      const onAbortListener = jest.fn();
      req.signal.addEventListener("abort", onAbortListener);

      jest.advanceTimersByTime(1001);

      expect(onAbortListener).toHaveBeenCalledTimes(1);
      expect(req.signal.aborted).toBe(true);
      expect(res.status).toHaveBeenCalledWith(408);
      expect(res.json).toHaveBeenCalledWith({ error: "Request Timeout" });
      expect(req.destroy).toHaveBeenCalledTimes(1);
    });

    it("does NOT abort req.signal when response completes cleanly", () => {
      const middleware = createRequestTimeout({ defaultTimeoutMs: 2000 });
      const req = createMockReq();
      const res = createMockRes();
      middleware(req, res, jest.fn());

      const onAbortListener = jest.fn();
      req.signal.addEventListener("abort", onAbortListener);

      // Response finished cleanly
      res.writableEnded = true;
      res.emit("finish");

      // Advance time past timeout
      jest.advanceTimersByTime(3000);

      expect(onAbortListener).not.toHaveBeenCalled();
      expect(req.signal.aborted).toBe(false);
      expect(res.status).not.toHaveBeenCalledWith(408);
    });
  });

  // =========================================================================
  // DIMENSION 4: Negative Controls & Idempotency
  // =========================================================================
  describe("Dimension 4: Negative Controls & No Side Effects", () => {
    it("does not write 408 if res.headersSent is true when timeout fires", () => {
      const middleware = createRequestTimeout({ defaultTimeoutMs: 1000 });
      const req = createMockReq();
      const res = createMockRes();
      middleware(req, res, jest.fn());

      res.headersSent = true;
      jest.advanceTimersByTime(1001);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(req.destroy).toHaveBeenCalled();
    });

    it("removes all event listeners on cleanup to prevent EventEmitter leaks", () => {
      const middleware = createRequestTimeout({ defaultTimeoutMs: 1000 });
      const req = createMockReq();
      const res = createMockRes();

      const initialResListeners = res.listenerCount("close") + res.listenerCount("finish");
      const initialReqListeners = req.listenerCount("close") + req.listenerCount("error");

      middleware(req, res, jest.fn());

      expect(res.listenerCount("finish")).toBeGreaterThan(0);
      expect(res.listenerCount("close")).toBeGreaterThan(0);

      res.emit("finish");

      expect(res.listenerCount("finish")).toBe(initialResListeners);
      expect(res.listenerCount("close")).toBe(initialResListeners);
      expect(req.listenerCount("close")).toBe(initialReqListeners);
      expect(req.listenerCount("error")).toBe(initialReqListeners);
    });

    it("works when called as factory requestTimeout(timeoutMs)", () => {
      const factoryMiddleware = requestTimeout(5000);
      expect(typeof factoryMiddleware).toBe("function");

      const req = createMockReq();
      const res = createMockRes();
      const next = jest.fn();

      factoryMiddleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(4999);
      expect(res.status).not.toHaveBeenCalledWith(408);

      jest.advanceTimersByTime(2);
      expect(res.status).toHaveBeenCalledWith(408);
    });

    it("works when mounted directly as app.use(requestTimeout)", () => {
      const req = createMockReq();
      const res = createMockRes();
      const next = jest.fn();

      requestTimeout(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(req.signal).toBeDefined();

      res.emit("finish");
      jest.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 100);
      expect(res.status).not.toHaveBeenCalledWith(408);
    });
  });

  // =========================================================================
  // DIMENSION 5: Stress, Concurrency & High Load Matrix (100+ requests)
  // =========================================================================
  describe("Dimension 5: Stress & High-Throughput Concurrent Disconnects", () => {
    const stressBatchSizes = [10, 25, 50, 100];

    stressBatchSizes.forEach((batchSize) => {
      it(`handles ${batchSize} concurrent mixed requests with zero leaked timers`, () => {
        const middleware = createRequestTimeout({ defaultTimeoutMs: 5000 });
        const connections: Array<{ req: any; res: any; type: "early_close" | "clean_finish" | "timeout" }> = [];

        for (let i = 0; i < batchSize; i++) {
          const req = createMockReq({ path: `/api/resource/${i}` });
          const res = createMockRes();
          const next = jest.fn();

          middleware(req, res, next);
          expect(next).toHaveBeenCalledTimes(1);

          const type = i % 3 === 0 ? "early_close" : i % 3 === 1 ? "clean_finish" : "timeout";
          connections.push({ req, res, type });
        }

        // Simulate immediate early closes for the first group
        connections
          .filter((c) => c.type === "early_close")
          .forEach((c) => {
            c.res.emit("close");
            expect(c.req.signal.aborted).toBe(true);
          });

        // Simulate clean finish for the second group at 2000ms
        jest.advanceTimersByTime(2000);
        connections
          .filter((c) => c.type === "clean_finish")
          .forEach((c) => {
            c.res.writableEnded = true;
            c.res.emit("finish");
            expect(c.req.signal.aborted).toBe(false);
          });

        // Advance to 6000ms to allow remaining timeout connections to trigger
        jest.advanceTimersByTime(4000);

        // Verify timeout group received 408
        connections
          .filter((c) => c.type === "timeout")
          .forEach((c) => {
            expect(c.res.status).toHaveBeenCalledWith(408);
            expect(c.req.signal.aborted).toBe(true);
          });

        // Verify non-timeout groups never received 408
        connections
          .filter((c) => c.type !== "timeout")
          .forEach((c) => {
            expect(c.res.status).not.toHaveBeenCalledWith(408);
          });
      });
    });

    // Generate 50 parameterized discrete lifecycle checks
    const parameterizedChecks = Array.from({ length: 50 }, (_, i) => ({
      index: i,
      abortAtMs: (i * 70) % 2000,
      path: i % 2 === 0 ? "/api/stellar/balance" : "/admin/reports",
      isClientClose: i % 4 !== 0,
    }));

    test.each(parameterizedChecks)(
      "parameterized lifecycle check #$index: disconnect at $abortAtMs ms on $path",
      ({ abortAtMs, path, isClientClose }) => {
        const middleware = createRequestTimeout({
          defaultTimeoutMs: 2500,
          adminTimeoutMs: 5000,
        });
        const req = createMockReq({ path });
        const res = createMockRes();
        const next = jest.fn();

        middleware(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(abortAtMs);

        if (isClientClose) {
          res.emit("close");
          expect(req.signal.aborted).toBe(true);
        } else {
          res.writableEnded = true;
          res.emit("finish");
          expect(req.signal.aborted).toBe(false);
        }

        // Advance past all timeouts
        jest.advanceTimersByTime(10000);
        expect(res.status).not.toHaveBeenCalledWith(408);
      }
    );
  });
});
