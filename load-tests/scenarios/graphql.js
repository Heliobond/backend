/**
 * GraphQL load test — exercises the /graphql endpoint under moderate concurrency.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errorRate = new Rate("errors");

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "3m", target: 10 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<600", "p(99)<1200"],
    errors: ["rate<0.01"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

const PROJECTS_QUERY = JSON.stringify({
  query: `{
    projects {
      id
      credit_quality
      green_impact
    }
  }`,
});

const HEALTH_QUERY = JSON.stringify({
  query: `{ __typename }`,
});

const headers = { "Content-Type": "application/json" };

export default function () {
  const introspectRes = http.post(`${BASE_URL}/graphql`, HEALTH_QUERY, { headers });
  const introspectOk = check(introspectRes, {
    "introspect: not 5xx": (r) => r.status < 500,
  });
  errorRate.add(!introspectOk);

  sleep(0.5);

  const projectsRes = http.post(`${BASE_URL}/graphql`, PROJECTS_QUERY, { headers });
  const projectsOk = check(projectsRes, {
    "projects query: not 5xx": (r) => r.status < 500,
    "projects query: has data or errors": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.data !== undefined || body.errors !== undefined;
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!projectsOk);

  sleep(1);
}
