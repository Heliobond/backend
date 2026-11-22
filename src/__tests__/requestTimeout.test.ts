import { EventEmitter } from "events";
import { createRequestTimeout } from "../middleware/requestTimeout";

interface MockResponse extends EventEmitter {
  locals: Record<string, unknown>;
  headersSent: boolean;
  writableEnded: boolean;
  status: jest.Mock;
  json: jest.Mock;
}

function makeResponse(): MockResponse {
  const res = new EventEmitter() as MockResponse;
  res.locals = {};
  res.headersSent = false;
  res.writableEnded = false;
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeRequest(path = "/v1/projects") {
  return { path, destroy: jest.fn() } as any;
}

describe("requestTimeout middleware", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("clears the timer when the client disconnects before finish", () => {
    const req = makeRequest();
    const res = makeResponse();
    const next = jest.fn();

    createRequestTimeout(1_000)(req, res as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    res.emit("close");

    expect(jest.getTimerCount()).toBe(0);

    jest.advanceTimersByTime(1_000);

    expect(req.destroy).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("aborts the downstream signal when the client disconnects early", () => {
    const req = makeRequest();
    const res = makeResponse();

    createRequestTimeout(1_000)(req, res as any, jest.fn());
    const signal = res.locals.abortSignal as AbortSignal;

    expect(signal.aborted).toBe(false);

    res.emit("close");

    expect(signal.aborted).toBe(true);
  });

  it("does not abort on a normal finish", () => {
    const req = makeRequest();
    const res = makeResponse();

    createRequestTimeout(1_000)(req, res as any, jest.fn());
    const signal = res.locals.abortSignal as AbortSignal;

    res.writableEnded = true;
    res.emit("finish");

    expect(jest.getTimerCount()).toBe(0);
    expect(signal.aborted).toBe(false);
  });

  it("writes 408, aborts, and destroys the request on timeout", () => {
    const req = makeRequest();
    const res = makeResponse();

    createRequestTimeout(1_000)(req, res as any, jest.fn());
    const signal = res.locals.abortSignal as AbortSignal;

    jest.advanceTimersByTime(1_000);

    expect(res.status).toHaveBeenCalledWith(408);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "request_timeout", message: "Request timed out" },
    });
    expect(signal.aborted).toBe(true);
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });

  it("supersedes a timer installed by an outer timeout middleware", () => {
    const req = makeRequest();
    const res = makeResponse();

    createRequestTimeout(1_000)(req, res as any, jest.fn());
    expect(jest.getTimerCount()).toBe(1);

    createRequestTimeout(5_000)(req, res as any, jest.fn());
    // Only the replacement timer should remain.
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(1_000);
    expect(res.status).not.toHaveBeenCalled();

    jest.advanceTimersByTime(4_000);
    expect(res.status).toHaveBeenCalledWith(408);
  });
});
