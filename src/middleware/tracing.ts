import { Request, Response, NextFunction } from "express";
import { trace, context, SpanKind, SpanStatusCode, propagation, ROOT_CONTEXT, Span } from "@opentelemetry/api";
import type { Attributes } from "@opentelemetry/api";
import { storeFinishedSpan } from "../lib/tracer";

const tracer = trace.getTracer("heliobond-backend");

/**
 * Express middleware that creates an OpenTelemetry span for every incoming HTTP
 * request, propagates context from incoming W3C Traceparent/Tracestate headers,
 * records custom attributes, and stores completed spans for the /v1/traces endpoint.
 */
export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Extract context from incoming headers (W3C Traceparent / B3 / etc.)
  const extractedContext = propagation.extract(ROOT_CONTEXT, req.headers);

  const spanName = `${req.method} ${req.route?.path ?? req.path}`;
  const span = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.SERVER,
      attributes: {
        "http.method": req.method,
        "http.url": req.originalUrl,
        "http.target": req.path,
        "http.host": req.hostname,
        "http.user_agent": req.headers["user-agent"] ?? "",
        "http.scheme": req.protocol,
        "http.request_content_length": Number(req.headers["content-length"]) || 0,
        "net.peer.ip": req.ip ?? "",
        "service.name": "heliobond-backend",
      },
    },
    extractedContext,
  );

  // Inject the span into the request context for downstream use
  const spanContext = trace.setSpan(extractedContext, span);
  const start = process.hrtime.bigint();

  // Propagate trace context to outgoing responses
  propagation.inject(spanContext, res.locals as Record<string, unknown>);

  // Set trace headers on the response so clients can correlate
  const spanId = span.spanContext().spanId;
  const traceId = span.spanContext().traceId;
  res.setHeader("X-Trace-Id", traceId);
  res.setHeader("X-Span-Id", spanId);

  // Collect custom attributes as we go
  const customAttrs: Attributes = {
    "http.method": req.method,
    "http.url": req.originalUrl,
    "http.target": req.path,
    "http.host": req.hostname,
    "service.name": "heliobond-backend",
  };

  res.on("finish", () => {
    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs) / 1e6;

    span.setAttributes({
      "http.status_code": res.statusCode,
      "http.response_content_length": Number(res.getHeader("content-length")) || 0,
      "http.latency_ms": Math.round(durationMs * 1000) / 1000,
    });

    customAttrs["http.status_code"] = res.statusCode;
    customAttrs["http.latency_ms"] = Math.round(durationMs * 1000) / 1000;

    if (res.statusCode >= 400) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `HTTP ${res.statusCode}`,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    // Store span data for the /v1/traces query endpoint
    storeFinishedSpan({
      traceId,
      spanId,
      name: spanName,
      kind: "SERVER",
      startTime: Number(start) / 1e6,
      endTime: Number(process.hrtime.bigint()) / 1e6,
      status: res.statusCode >= 400 ? "ERROR" : "OK",
      attributes: customAttrs as Record<string, unknown>,
      events: [],
    });

    span.end();
  });

  // Run downstream handlers inside the span context
  context.with(spanContext, () => next());
}

/**
 * Helper to attach custom attributes to the current active span from anywhere
 * in the request lifecycle (e.g. inside route handlers or service functions).
 */
export function setTraceAttributes(attrs: Attributes): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttributes(attrs);
  }
}

/**
 * Helper to create a child span from within a request handler.
 * The child automatically inherits the parent trace context.
 */
export function createChildSpan(name: string, kind: SpanKind = SpanKind.INTERNAL): Span {
  return tracer.startSpan(name, { kind });
}
