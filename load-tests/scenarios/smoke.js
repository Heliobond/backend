/**
 * Smoke test — verifies core endpoints are reachable and respond correctly.
 * Runs with 1 VU for 30 seconds. Should always pass before heavier tests.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errorRate = new Rate("errors");

export const options = {
  vus: 1,
  duration: "30s",
  thresholds: {
    http_req_duration: ["p(95)<100"],
    errors: ["rate<0.01"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

export default function () {
  // Health check
  const healthRes = http.get(`${BASE_URL}/health`);
  const healthOk = check(healthRes, {
    "health: status 200": (r) => r.status === 200,
    "health: has status field": (r) => {
      try {
        return JSON.parse(r.body).status !== undefined;
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!healthOk);

  sleep(1);

  // Public IoT endpoint
  const iotRes = http.get(`${BASE_URL}/v1/iot`);
  const iotOk = check(iotRes, {
    "iot: not 5xx": (r) => r.status < 500,
  });
  errorRate.add(!iotOk);

  sleep(1);

  // Projects listing
  const projectsRes = http.get(`${BASE_URL}/v1/projects`);
  const projectsOk = check(projectsRes, {
    "projects: not 5xx": (r) => r.status < 500,
  });
  errorRate.add(!projectsOk);

  sleep(1);
}
