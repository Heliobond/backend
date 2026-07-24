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

const startTime = Date.now();
const requestWindow: Array<{ status: number; latency: number; timestamp: number }> = [];
const MAX_WINDOW_SIZE = 10000;

export function recordRequest(method: string, path: string, status: number, latencyMs: number): void {
  const timestamp = Date.now();
  requestWindow.push({ status, latency: latencyMs, timestamp });

  if (requestWindow.length > MAX_WINDOW_SIZE) {
    requestWindow.shift();
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
  const byPath: PathMetrics = {};

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
