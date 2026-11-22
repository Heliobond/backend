import { trace, context, SpanKind, SpanStatusCode, Span, Attributes } from "@opentelemetry/api";

// ── Singleton tracer ────────────────────────────────────────────────────────
const tracer = trace.getTracer("heliobond-backend", process.env.npm_package_version ?? "1.0.0");

export { tracer };

// ── Span creation helpers ───────────────────────────────────────────────────

export interface SpanOptions {
  name: string;
  kind?: SpanKind;
  attributes?: Attributes;
  parent?: ReturnType<typeof context.active>;
}

/**
 * Create a new span, run fn inside it, and automatically handle errors/status.
 */
export async function withSpan<T>(opts: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = tracer.startSpan(opts.name, {
    kind: opts.kind ?? SpanKind.INTERNAL,
    attributes: opts.attributes,
  }, opts.parent ?? context.active());

  try {
    const result = await context.with(trace.setSpan(context.active(), span), () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Synchronous variant of withSpan.
 */
export function withSpanSync<T>(opts: SpanOptions, fn: (span: Span) => T): T {
  const span = tracer.startSpan(opts.name, {
    kind: opts.kind ?? SpanKind.INTERNAL,
    attributes: opts.attributes,
  }, opts.parent ?? context.active());

  try {
    const result = context.with(trace.setSpan(context.active(), span), () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
  }
}

// ── Custom attribute helpers ────────────────────────────────────────────────

export function setSpanAttributes(span: Span, attrs: Attributes): void {
  span.setAttributes(attrs);
}

export function addSpanEvent(span: Span, name: string, attrs?: Attributes): void {
  span.addEvent(name, attrs);
}

// ── In-memory span store for /v1/traces endpoint ────────────────────────────

interface StoredSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; time: number; attributes?: Record<string, unknown> }>;
  correlationId?: string;
}

const MAX_STORED_SPANS = 5000;
const spanStore: StoredSpan[] = [];

export function storeFinishedSpan(spanData: {
  traceId: string;
  spanId: string;
  name: string;
  kind: string;
  startTime: number;
  endTime: number;
  status: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; time: number; attributes?: Record<string, unknown> }>;
}): void {
  const stored: StoredSpan = {
    ...spanData,
    durationMs: (spanData.endTime - spanData.startTime) / 1e6,
    correlationId: spanData.attributes?.["correlation_id"] as string | undefined,
  };
  spanStore.push(stored);
  if (spanStore.length > MAX_STORED_SPANS) {
    spanStore.shift();
  }
}

export interface TraceQuery {
  correlationId?: string;
  limit?: number;
  since?: number;
}

export function getTraces(query: TraceQuery): StoredSpan[] {
  let results = spanStore;
  if (query.correlationId) {
    results = results.filter((s) => s.correlationId === query.correlationId);
  }
  if (query.since != null) {
    results = results.filter((s) => s.startTime >= query.since!);
  }
  const limit = query.limit ?? 100;
  return results.slice(-limit);
}

export interface TraceSummary {
  total_spans: number;
  traces: number;
  avg_duration_ms: number;
  error_rate: number;
  p95_duration_ms: number;
  p99_duration_ms: number;
  top_slowest: Array<{ name: string; avg_duration_ms: number; count: number }>;
}

export function getTraceSummary(): TraceSummary {
  if (spanStore.length === 0) {
    return {
      total_spans: 0,
      traces: 0,
      avg_duration_ms: 0,
      error_rate: 0,
      p95_duration_ms: 0,
      p99_duration_ms: 0,
      top_slowest: [],
    };
  }

  const traceIds = new Set(spanStore.map((s) => s.traceId));
  const durations = spanStore.map((s) => s.durationMs).sort((a, b) => a - b);
  const errors = spanStore.filter((s) => s.status === "ERROR").length;

  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
  const p99 = durations[Math.floor(durations.length * 0.99)] ?? 0;

  // Aggregate by span name for top slowest
  const byName = new Map<string, { total: number; count: number }>();
  for (const s of spanStore) {
    const existing = byName.get(s.name) ?? { total: 0, count: 0 };
    existing.total += s.durationMs;
    existing.count += 1;
    byName.set(s.name, existing);
  }
  const topSlowest = [...byName.entries()]
    .map(([name, v]) => ({ name, avg_duration_ms: v.total / v.count, count: v.count }))
    .sort((a, b) => b.avg_duration_ms - a.avg_duration_ms)
    .slice(0, 10);

  return {
    total_spans: spanStore.length,
    traces: traceIds.size,
    avg_duration_ms: Math.round(avgDuration * 100) / 100,
    error_rate: Math.round((errors / spanStore.length) * 10000) / 10000,
    p95_duration_ms: Math.round(p95 * 100) / 100,
    p99_duration_ms: Math.round(p99 * 100) / 100,
    top_slowest: topSlowest,
  };
}
