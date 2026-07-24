/**
 * Average load test — simulates typical production traffic across public endpoints.
 * Ramps to 20 VUs over 1 minute, holds for 5 minutes, then ramps down.
 */
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const projectsDuration = new Trend("projects_duration");
const dashboardDuration = new Trend("dashboard_duration");

export const options = {
  stages: [
    { duration: "1m", target: 20 },
    { duration: "5m", target: 20 },
    { duration: "1m", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<1000"],
    errors: ["rate<0.01"],
    projects_duration: ["p(95)<500"],
    dashboard_duration: ["p(95)<500"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

export default function () {
  group("health", () => {
    const res = http.get(`${BASE_URL}/health`);
    const ok = check(res, {
      "status 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(0.5);

  group("public endpoints", () => {
    const projectsRes = http.get(`${BASE_URL}/v1/projects`);
    projectsDuration.add(projectsRes.timings.duration);
    const projectsOk = check(projectsRes, {
      "projects: not 5xx": (r) => r.status < 500,
    });
    errorRate.add(!projectsOk);

    sleep(0.3);

    const dashboardRes = http.get(`${BASE_URL}/v1/dashboard`);
    dashboardDuration.add(dashboardRes.timings.duration);
    const dashboardOk = check(dashboardRes, {
      "dashboard: not 5xx": (r) => r.status < 500,
    });
    errorRate.add(!dashboardOk);

    sleep(0.3);

    const iotRes = http.get(`${BASE_URL}/v1/iot`);
    const iotOk = check(iotRes, {
      "iot: not 5xx": (r) => r.status < 500,
    });
    errorRate.add(!iotOk);

    sleep(0.3);

    const financialRes = http.get(`${BASE_URL}/v1/financial`);
    const financialOk = check(financialRes, {
      "financial: not 5xx": (r) => r.status < 500,
    });
    errorRate.add(!financialOk);
  });

  sleep(1);
}
