interface RequestMetrics {
  total_requests: number;

  total_errors: number;
  total_success: number;
  error_rate: number;
  success_rate: number;
  avg_response_time_ms: number;
  requests_per_minute: number;
  errors_per_minute: number;
}

interface MethodMetrics {
  [method: string]: {
    count: number;
    errors: number;
    avg_latency_ms: number;
  };
}

interface PathMetrics {
  [path: string]: {
    count: number;
    errors: number;
    avg_latency_ms: number;
  };
}

interface MetricsSnapshot {
  timestamp: string;
  uptime_seconds: number;
  requests: RequestMetrics;
  by_method: MethodMetrics;
  by_path: PathMetrics;
}

interface RequestEntry {
  method: string;
  path: string;
  status: number;
  latency: number;
  timestamp: number;
}

interface MethodCounter {
  count: number;
  errors: number;
  totalLatencyMs: number;
}

interface PathCounter {
  count: number;
  errors: number;
  totalLatencyMs: number;
}

const startTime = Date.now(); const requestWindow: RequestEntry[] = []; const MAX_WINDOW_SIZE = 10000; const methodCounters: { [method: string]: MethodCounter } = {}; const pathCounters: { [path: string]: PathCounter } = {}; 
export function recordRequest(method: string, path: string, status: number, latencyMs: number): void {
  const timestamp = Date.now();
  requestWindow.push({ method, path, status, latency: latencyMs, timestamp });

  const methodCounter = methodCounters[method] ||= { count: 0, errors: 0, totalLatencyMs: 0 };
  methodCounter.count++;
  methodCounter.totalLatencyMs += latencyMs;
  if (status >= 400) methodCounter.errors++;

  const pathCounter = pathCounters[path] ||= { count: 0, errors: 0, totalLatencyMs: 0 };
  pathCounter.count++;
  pathCounter.totalLatencyMs += latencyMs;
  if (status >= 400) pathCounter.errors++;

  if (requestWindow.length > MAX_WINDOW_SIZE) {
    const removed = requestWindow.shift();
    if (removed) {
      const mc = methodCounters[removed.method];
      if (mc) {
        mc.count--;
        mc.totalLatencyMs -= removed.latency;
        if (removed.status >= 400) mc.errors--;
        if (mc.count <= 0) delete methodCounters[removed.method];
      }

      const pc = pathCounters[removed.path];
      if (pc) {
        pc.count--;
        pc.totalLatencyMs -= removed.latency;
        if (removed.status >= 400) pc.errors--;
        if (pc.count <= 0) delete pathCounters[removed.path];
      }
    }
  }
}

export function getMetrics(): MetricsSnapshot {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;

  const recentRequests = requestWindow.filter((r) => r.timestamp > oneMinuteAgo);

  const totalRequests = requestWindow.length;
  const totalErrors = requestWindow.filter((r) => r.status >= 400).length;
  const totalSuccess = totalRequests - totalErrors;

  const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;
  const successRate = totalRequests > 0 ? totalSuccess / totalRequests : 0;

  const avgLatency =
    totalRequests > 0 ? requestWindow.reduce((sum, r) => sum + r.latency, 0) / totalRequests : 0;

  const requestsPerMinute = recentRequests.length;
  const errorsPerMinute = recentRequests.filter((r) => r.status >= 400).length;

  const byMethod: MethodMetrics = {};
  for (const method of Object.keys(methodCounters)) {
    const counter = methodCounters[method];
    byMethod[method] = {
      count: counter.count,
      errors: counter.errors,
      avg_latency_ms: counter.count > 0 ? Math.round((counter.totalLatencyMs / counter.count) * 100) / 100 : 0,
    };
  }

  const byPath: PathMetrics = {};
  for (const path of Object.keys(pathCounters)) {
    const counter = pathCounters[path];
    byPath[path] = {
      count: counter.count,
      errors: counter.errors,
      avg_latency_ms: counter.count > 0 ? Math.round((counter.totalLatencyMs / counter.count) * 100) / 100 : 0,
    };
  }

  return {
    timestamp: new Date(now).toISOString(),
    uptime_seconds: Math.floor((now - startTime) / 1000),
    requests: {
      total_requests: totalRequests,
      total_errors: totalErrors,
      total_success: totalSuccess,
      error_rate: Math.round(errorRate * 10000) / 10000,
      success_rate: Math.round(successRate * 10000) / 10000,
      avg_response_time_ms: Math.round(avgLatency * 100) / 100,
      requests_per_minute: requestsPerMinute,
      errors_per_minute: errorsPerMinute,
    },
    by_method: byMethod,
    by_path: byPath,
  };
}