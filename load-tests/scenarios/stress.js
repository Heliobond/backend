/**
 * Stress test — pushes the system beyond normal capacity to find breaking points.
 * Ramps aggressively to 100 VUs, holds, then ramps back down.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errorRate = new Rate("errors");

export const options = {
  stages: [
    { duration: "2m", target: 50 },
    { duration: "3m", target: 100 },
    { duration: "3m", target: 100 },
    { duration: "2m", target: 0 },
  ],
  thresholds: {
    // Stress test uses relaxed thresholds — goal is to observe, not necessarily pass
    http_req_duration: ["p(95)<2000"],
    errors: ["rate<0.10"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

export default function () {
  const endpoints = [
    "/health",
    "/v1/projects",
    "/v1/dashboard",
    "/v1/iot",
    "/v1/financial",
    "/v1/forecast",
    "/v1/comparison",
    "/v1/portfolio",
  ];

  const url = `${BASE_URL}${endpoints[Math.floor(Math.random() * endpoints.length)]}`;
  const res = http.get(url);

  const ok = check(res, {
    "not 5xx": (r) => r.status < 500,
    "response time < 2s": (r) => r.timings.duration < 2000,
  });
  errorRate.add(!ok);

  sleep(0.5);
}
