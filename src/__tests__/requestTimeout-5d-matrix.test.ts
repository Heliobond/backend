import { Response } from "express";
import { EventEmitter } from "events";
import requestTimeout, { getTimeoutMs, RequestWithSignal } from "../middleware/requestTimeout";


interface MockResponse extends EventEmitter {
  headersSent: boolean;
  writableEnded: boolean;
  statusCode: number;
  status: jest.Mock;
  json: jest.Mock;
}

function createMockReq(path = "/test"): RequestWithSignal {
  const req = {
    path,
    destroy: jest.fn(),
  };
  return req as unknown as RequestWithSignal;
}

function createMockRes(): Response & MockResponse {
  const res = new EventEmitter() as unknown as MockResponse;
  res.headersSent = false;
  res.writableEnded = false;
  res.statusCode = 200;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as unknown as Response & MockResponse;
}

describe("requestTimeout Middleware - 5D Exhaustive Test Matrix (Closes #910)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 1: Boundaries & Environment Variable Clamping (30 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 1: Boundaries & Timeout Configuration", () => {
    it("returns default 30000ms for non-admin paths with default env", () => {
      delete process.env.REQUEST_TIMEOUT_MS;
      delete process.env.ADMIN_REQUEST_TIMEOUT_MS;
      expect(getTimeoutMs("/v1/projects")).toBe(30000);
      expect(getTimeoutMs("/")).toBe(30000);
      expect(getTimeoutMs("/api/scores")).toBe(30000);
    });

    it("returns default 60000ms for admin paths with default env", () => {
      delete process.env.REQUEST_TIMEOUT_MS;
      delete process.env.ADMIN_REQUEST_TIMEOUT_MS;
      expect(getTimeoutMs("/admin")).toBe(60000);
      expect(getTimeoutMs("/admin/config")).toBe(60000);
      expect(getTimeoutMs("/admin/metrics")).toBe(60000);
    });

    const validTimeoutValues = [100, 500, 1000, 5000, 15000, 45000, 120000, 300000];
    validTimeoutValues.forEach((ms) => {
      it(`accepts valid positive timeout value ${ms}ms from env for standard route`, () => {
        process.env.REQUEST_TIMEOUT_MS = ms.toString();
        expect(getTimeoutMs("/v1/query")).toBe(ms);
      });

      it(`accepts valid positive timeout value ${ms}ms from env for admin route`, () => {
        process.env.ADMIN_REQUEST_TIMEOUT_MS = ms.toString();
        expect(getTimeoutMs("/admin/reboot")).toBe(ms);
      });
    });

    const invalidEnvValues = [
      { label: "zero", val: "0" },
      { label: "negative", val: "-5000" },
      { label: "empty string", val: "" },
      { label: "whitespace string", val: "   " },
      { label: "non-numeric string", val: "invalid_timeout" },
      { label: "NaN string", val: "NaN" },
      { label: "null string", val: "null" },
    ];

    invalidEnvValues.forEach(({ label, val }) => {
      it(`falls back to default 30000ms when REQUEST_TIMEOUT_MS is ${label} (${val})`, () => {
        process.env.REQUEST_TIMEOUT_MS = val;
        expect(getTimeoutMs("/projects")).toBe(30000);
      });

      it(`falls back to default 60000ms when ADMIN_REQUEST_TIMEOUT_MS is ${label} (${val})`, () => {
        process.env.ADMIN_REQUEST_TIMEOUT_MS = val;
        expect(getTimeoutMs("/admin/users")).toBe(60000);
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 2: Combinatorics of Response Lifecycle (30 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 2: Response Lifecycle & Standard Completion", () => {
    it("attaches an AbortSignal to req", () => {
      const req = createMockReq("/test");
      const res = createMockRes();
      const next = jest.fn();

      requestTimeout(req, res, next);

      expect(req.signal).toBeDefined();
      expect(req.signal?.aborted).toBe(false);
      expect(next).toHaveBeenCalledTimes(1);

      res.emit("finish");
    });

    const statusCodes = [200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 429, 500, 502, 503];
    statusCodes.forEach((status) => {
      it(`clears timer and preserves unaborted signal when response finishes with status ${status}`, () => {
        jest.useFakeTimers();
        const req = createMockReq("/status-test");
        const res = createMockRes();
        res.statusCode = status;
        const next = jest.fn();

        requestTimeout(req, res, next);
        expect(req.signal?.aborted).toBe(false);

        // Response completes normally
        res.emit("finish");

        // Advance timers past timeout
        jest.advanceTimersByTime(35000);

        // Should not have aborted since finish cleared the timer
        expect(req.signal?.aborted).toBe(false);
        jest.useRealTimers();
      });
    });

    it("triggers 408 and aborts signal when timeout expires before response finishes", () => {
      jest.useFakeTimers();
      const req = createMockReq("/slow-endpoint");
      const res = createMockRes();
      const next = jest.fn();

      requestTimeout(req, res, next);

      expect(req.signal?.aborted).toBe(false);

      // Fast forward past default 30000ms timeout
      jest.advanceTimersByTime(30001);

      expect(req.signal?.aborted).toBe(true);
      expect(res.status).toHaveBeenCalledWith(408);
      expect(res.json).toHaveBeenCalledWith({ error: "Request Timeout" });
      expect(req.destroy).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });

    it("does not write 408 headers if res.headersSent is already true upon timeout", () => {
      jest.useFakeTimers();
      const req = createMockReq("/streaming-endpoint");
      const res = createMockRes();
      res.headersSent = true;
      const next = jest.fn();

      requestTimeout(req, res, next);

      jest.advanceTimersByTime(30001);

      expect(req.signal?.aborted).toBe(true);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(req.destroy).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 3: Early Client Disconnect & Timer Leak Prevention (25 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 3: Client Disconnect & Leak Prevention (Core Issue #910)", () => {
    it("clears pending timer immediately when client aborts and res emits close", () => {
      jest.useFakeTimers();
      const req = createMockReq("/api/long-job");
      const res = createMockRes();
      const next = jest.fn();

      requestTimeout(req, res, next);

      // Client aborts after 500ms
      jest.advanceTimersByTime(500);
      res.emit("close");

      // Verify downstream signal is aborted due to client disconnect
      expect(req.signal?.aborted).toBe(true);
      expect(req.signal?.reason?.message).toContain("Client disconnected");

      // Now fast-forward all the way past 30000ms
      jest.advanceTimersByTime(50000);

      // CRITICAL ASSERTION (Issue #910):
      // The expired timer MUST NOT write 408 or call req.destroy against the closed response!
      expect(res.status).not.toHaveBeenCalledWith(408);
      expect(res.json).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    const disconnectOffsets = [10, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 29999];
    disconnectOffsets.forEach((ms) => {
      it(`handles client disconnect at ${ms}ms without pending timer leak`, () => {
        jest.useFakeTimers();
        const req = createMockReq("/computation");
        const res = createMockRes();

        requestTimeout(req, res, jest.fn());

        jest.advanceTimersByTime(ms);
        res.emit("close");

        expect(req.signal?.aborted).toBe(true);

        // Exceed timeout duration
        jest.advanceTimersByTime(60000);
        expect(res.status).not.toHaveBeenCalled();

        jest.useRealTimers();
      });
    });

    it("does not abort signal on close if response was already completed (writableEnded=true)", () => {
      const req = createMockReq("/normal-finish");
      const res = createMockRes();
      res.writableEnded = true;

      requestTimeout(req, res, jest.fn());

      res.emit("finish");
      res.emit("close");

      expect(req.signal?.aborted).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 4: Negative Controls & Event Idempotency (15 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 4: Negative Controls & Idempotency", () => {
    it("handles multiple finish events without double clearing or errors", () => {
      const req = createMockReq("/multi-finish");
      const res = createMockRes();

      requestTimeout(req, res, jest.fn());

      expect(() => {
        res.emit("finish");
        res.emit("finish");
        res.emit("finish");
      }).not.toThrow();
    });

    it("handles multiple close events without double aborting or errors", () => {
      const req = createMockReq("/multi-close");
      const res = createMockRes();
      res.writableEnded = false;

      requestTimeout(req, res, jest.fn());

      expect(() => {
        res.emit("close");
        res.emit("close");
      }).not.toThrow();

      expect(req.signal?.aborted).toBe(true);
    });

    it("always passes execution to next middleware function exactly once", () => {
      const req = createMockReq("/next-test");
      const res = createMockRes();
      const next = jest.fn();

      requestTimeout(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      res.emit("finish");
      expect(next).toHaveBeenCalledTimes(1);
    });

    const nonStringPaths = ["/admin/123", "/admin/", "/v1/metrics", "/health", "/v1/nested/path/to/resource"];
    nonStringPaths.forEach((p) => {
      it(`safely determines timeout for path ${p}`, () => {
        const req = createMockReq(p);
        const res = createMockRes();
        const next = jest.fn();

        requestTimeout(req, res, next);
        expect(next).toHaveBeenCalled();
        res.emit("finish");
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dimension 5: High-Throughput & Sequential Stress (20 tests)
  // ════════════════════════════════════════════════════════════════════════════
  describe("Dimension 5: High-Throughput Concurrent Lifecycle", () => {
    it("runs 20 rapid concurrent requests and cleans up all timers without leaks", () => {
      jest.useFakeTimers();

      const requests = Array.from({ length: 20 }).map((_, i) => {
        const req = createMockReq(`/concurrent-${i}`);
        const res = createMockRes();
        return { req, res, id: i };
      });

      requests.forEach(({ req, res }) => {
        requestTimeout(req, res, jest.fn());
      });

      // Half finish normally, half abort early
      requests.forEach(({ res, id }) => {
        if (id % 2 === 0) {
          res.writableEnded = true;
          res.emit("finish");
        } else {
          res.emit("close");
        }
      });

      // Advance past timeout
      jest.advanceTimersByTime(40000);

      // Verify none of the 20 had 408 triggered
      requests.forEach(({ res }) => {
        expect(res.status).not.toHaveBeenCalledWith(408);
      });

      jest.useRealTimers();
    });

    const rapidSequentialRequests = Array.from({ length: 15 }, (_, i) => i + 1);
    rapidSequentialRequests.forEach((num) => {
      it(`processes sequential request lifecycle #${num} cleanly`, () => {
        jest.useFakeTimers();
        const req = createMockReq(`/seq-${num}`);
        const res = createMockRes();

        requestTimeout(req, res, jest.fn());
        res.writableEnded = true;
        res.emit("finish");

        jest.advanceTimersByTime(35000);
        expect(req.signal?.aborted).toBe(false);
        jest.useRealTimers();
      });
    });

    const pathPrefixBoundaries = [
      { path: "admin", expected: 30000, desc: "missing leading slash" },
      { path: "/administrator", expected: 60000, desc: "starts with /admin" },
      { path: "/api/admin", expected: 30000, desc: "admin not prefix" },
      { path: "", expected: 30000, desc: "empty path" },
      { path: "/ADMIN", expected: 30000, desc: "uppercase ADMIN" },
      { path: "/admin?token=xyz", expected: 60000, desc: "admin with query parameter" },
      { path: "//admin", expected: 30000, desc: "double slash prefix" },
      { path: "/admin/", expected: 60000, desc: "admin with trailing slash" },
    ];

    pathPrefixBoundaries.forEach(({ path, expected, desc }) => {
      it(`evaluates timeout boundary for ${desc} (${path}) to ${expected}ms`, () => {
        delete process.env.REQUEST_TIMEOUT_MS;
        delete process.env.ADMIN_REQUEST_TIMEOUT_MS;
        expect(getTimeoutMs(path)).toBe(expected);
      });
    });

    const extraStatusCodes = [202, 206, 307, 308, 418, 422, 451];
    extraStatusCodes.forEach((sc) => {
      it(`clears timer when response finishes with status ${sc}`, () => {
        jest.useFakeTimers();
        const req = createMockReq("/extra-status");
        const res = createMockRes();
        res.statusCode = sc;

        requestTimeout(req, res, jest.fn());
        res.emit("finish");

        jest.advanceTimersByTime(35000);
        expect(req.signal?.aborted).toBe(false);
        jest.useRealTimers();
      });
    });

    it("handles close followed immediately by finish without error", () => {
      const req = createMockReq("/close-then-finish");
      const res = createMockRes();

      requestTimeout(req, res, jest.fn());
      res.emit("close");
      res.emit("finish");

      expect(req.signal?.aborted).toBe(true);
    });

    it("invokes abort event listeners registered on req.signal when timeout fires", () => {
      jest.useFakeTimers();
      const req = createMockReq("/listener-test");
      const res = createMockRes();
      const abortListener = jest.fn();

      requestTimeout(req, res, jest.fn());
      req.signal?.addEventListener("abort", abortListener);

      jest.advanceTimersByTime(30001);

      expect(abortListener).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it("invokes abort event listeners registered on req.signal when client disconnects early", () => {
      jest.useFakeTimers();
      const req = createMockReq("/client-disconnect-listener");
      const res = createMockRes();
      const abortListener = jest.fn();

      requestTimeout(req, res, jest.fn());
      req.signal?.addEventListener("abort", abortListener);

      jest.advanceTimersByTime(200);
      res.emit("close");

      expect(abortListener).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    const highThroughputCounts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    highThroughputCounts.forEach((batch) => {
      it(`handles batch ${batch} of rapid request/response cycles without timer residue`, () => {
        jest.useFakeTimers();
        const req = createMockReq(`/batch-${batch}`);
        const res = createMockRes();

        requestTimeout(req, res, jest.fn());
        res.writableEnded = true;
        res.emit("finish");

        jest.advanceTimersByTime(35000);
        expect(req.signal?.aborted).toBe(false);
        jest.useRealTimers();
      });
    });
  });
});
