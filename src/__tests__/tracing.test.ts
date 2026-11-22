import { Request, Response, NextFunction } from "express";
import { tracingMiddleware, setTraceAttributes, createChildSpan } from "../middleware/tracing";
import * as api from "@opentelemetry/api";

jest.mock("@opentelemetry/api", () => {
  const actual = jest.requireActual("@opentelemetry/api");
  const mockSpan = {
    spanContext: jest.fn().mockReturnValue({ spanId: "test-span-id", traceId: "test-trace-id" }),
    setAttributes: jest.fn(),
    setStatus: jest.fn(),
    end: jest.fn(),
  };
  return {
    ...actual,
    trace: {
      getTracer: jest.fn().mockReturnValue({
        startSpan: jest.fn().mockReturnValue(mockSpan),
      }),
      setSpan: jest.fn().mockReturnValue({}),
      getActiveSpan: jest.fn().mockReturnValue(mockSpan),
    },
    propagation: {
      extract: jest.fn().mockReturnValue({}),
      inject: jest.fn(),
    },
    context: {
      with: jest.fn().mockImplementation((ctx, cb) => cb()),
    },
  };
});

jest.mock("../lib/tracer", () => ({
  storeFinishedSpan: jest.fn(),
}));

import { storeFinishedSpan } from "../lib/tracer";

describe("tracingMiddleware", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFunction: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      method: "GET",
      originalUrl: "/test-url",
      path: "/test-path",
      hostname: "localhost",
      headers: {
        "user-agent": "test-agent",
        "content-length": "100",
      },
      protocol: "http",
      ip: "127.0.0.1",
    };

    mockRes = {
      locals: {},
      setHeader: jest.fn(),
      on: jest.fn().mockImplementation((event, cb) => {
        // don't call cb immediately, will call manually
        return mockRes;
      }),
      statusCode: 200,
      getHeader: jest.fn().mockReturnValue("200"),
    };

    nextFunction = jest.fn();
  });

  it("should create a span, inject trace context and call next", () => {
    tracingMiddleware(mockReq as Request, mockRes as Response, nextFunction);
    
    expect(api.trace.getTracer("heliobond-backend").startSpan).toHaveBeenCalled();
    expect(mockRes.setHeader).toHaveBeenCalledWith("X-Trace-Id", "test-trace-id");
    expect(mockRes.setHeader).toHaveBeenCalledWith("X-Span-Id", "test-span-id");
    expect(nextFunction).toHaveBeenCalled();
  });

  it("should record success on finish event", () => {
    let finishCb: () => void = () => {};
    mockRes.on = jest.fn().mockImplementation((event, cb) => {
      if (event === "finish") {
        finishCb = cb;
      }
      return mockRes;
    });

    tracingMiddleware(mockReq as Request, mockRes as Response, nextFunction);
    
    // simulate response finish
    finishCb();

    const mockSpan = api.trace.getActiveSpan();
    expect(mockSpan?.setStatus).toHaveBeenCalledWith({ code: api.SpanStatusCode.OK });
    expect(storeFinishedSpan).toHaveBeenCalled();
  });

  it("should record error status when status code >= 400", () => {
    mockRes.statusCode = 404;
    let finishCb: () => void = () => {};
    mockRes.on = jest.fn().mockImplementation((event, cb) => {
      if (event === "finish") {
        finishCb = cb;
      }
      return mockRes;
    });

    tracingMiddleware(mockReq as Request, mockRes as Response, nextFunction);
    
    finishCb();

    const mockSpan = api.trace.getActiveSpan();
    expect(mockSpan?.setStatus).toHaveBeenCalledWith({ code: api.SpanStatusCode.ERROR, message: "HTTP 404" });
    expect(storeFinishedSpan).toHaveBeenCalled();
  });
});

describe("tracing helpers", () => {
  it("should setTraceAttributes", () => {
    setTraceAttributes({ test: 123 });
    const mockSpan = api.trace.getActiveSpan();
    expect(mockSpan?.setAttributes).toHaveBeenCalledWith({ test: 123 });
  });

  it("should createChildSpan", () => {
    const span = createChildSpan("child-span", api.SpanKind.INTERNAL);
    expect(span).toBeDefined();
    expect(api.trace.getTracer("heliobond-backend").startSpan).toHaveBeenCalledWith("child-span", { kind: api.SpanKind.INTERNAL });
  });
});
