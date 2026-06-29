import { getCorrelationId } from "./correlation";

export interface TraceSpan {
  spanId: string;
  correlationId: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attributes: Record<string, unknown>;
  status: "running" | "success" | "error";
  error?: string;
}

const MAX_SPANS = 2000;
const spans: TraceSpan[] = [];
let spanSeq = 0;

function generateSpanId(): string {
  return `span-${Date.now()}-${(++spanSeq).toString(36)}`;
}

function recordSpan(span: TraceSpan): void {
  spans.push(span);
  if (spans.length > MAX_SPANS) {
    spans.splice(0, spans.length - MAX_SPANS);
  }
}

export function startSpan(name: string, attributes?: Record<string, unknown>): TraceSpan {
  const span: TraceSpan = {
    spanId: generateSpanId(),
    correlationId: getCorrelationId(),
    name,
    startTime: Date.now(),
    attributes: attributes ?? {},
    status: "running",
  };
  recordSpan(span);
  return span;
}

export function finishSpan(span: TraceSpan, status: "success" | "error" = "success", error?: string): void {
  span.endTime = Date.now();
  span.durationMs = span.endTime - span.startTime;
  span.status = status;
  if (error) span.error = error;
}

export async function traceAsync<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, unknown>
): Promise<T> {
  const span = startSpan(name, attributes);
  try {
    const result = await fn();
    finishSpan(span, "success");
    return result;
  } catch (err: any) {
    finishSpan(span, "error", err?.message ?? String(err));
    throw err;
  }
}

export function getTraces(opts: {
  correlationId?: string;
  limit?: number;
  since?: number;
}): TraceSpan[] {
  const { correlationId, limit = 100, since } = opts;
  let result = spans.slice();
  if (correlationId) {
    result = result.filter((s) => s.correlationId === correlationId);
  }
  if (since !== undefined) {
    result = result.filter((s) => s.startTime >= since);
  }
  return result.slice(-limit);
}

export function getTraceSummary(): { total: number; running: number; success: number; error: number; oldestMs: number | null } {
  let running = 0;
  let success = 0;
  let error = 0;
  let oldest: number | null = null;

  for (const s of spans) {
    if (s.status === "running") running++;
    else if (s.status === "success") success++;
    else error++;
    if (oldest === null || s.startTime < oldest) oldest = s.startTime;
  }

  return { total: spans.length, running, success, error, oldestMs: oldest };
}
