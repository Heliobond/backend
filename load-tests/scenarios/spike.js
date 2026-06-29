/**
 * Spike test — simulates a sudden, sharp traffic spike (e.g., viral event or bot traffic).
 * Sits at a baseline, spikes to 200 VUs, then drops back to baseline.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errorRate = new Rate("errors");

export const options = {
  stages: [
    { duration: "1m", target: 10 },
    { duration: "30s", target: 200 },
    { duration: "1m", target: 200 },
    { duration: "30s", target: 10 },
    { duration: "2m", target: 10 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<3000"],
    errors: ["rate<0.15"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

export default function () {
  const res = http.get(`${BASE_URL}/health`);
  const ok = check(res, {
    "alive during spike": (r) => r.status === 200,
  });
  errorRate.add(!ok);

  sleep(0.2);

  const projectsRes = http.get(`${BASE_URL}/v1/projects`);
  const projectsOk = check(projectsRes, {
    "projects: not 5xx": (r) => r.status < 500,
  });
  errorRate.add(!projectsOk);

  sleep(0.3);
}
