/**
 * Route-table regression test for issue #760.
 *
 * These tests boot the REAL app exported by `src/index.ts` — never a
 * hand-assembled router — so that the order in which routers are mounted is
 * actually exercised. Previously `projectsRouter` was mounted at `/projects`
 * before `aggregateRouter` at `/projects/aggregate`, so `GET
 * /v1/projects/aggregate` was captured by `projectsRouter`'s `/:id` route with
 * `id = "aggregate"` and rejected by `parseProjectId` with a 400.
 *
 * The last case enumerates every documented `/v1` GET path so that a future
 * mount-ordering regression cannot silently reappear.
 */
import fs from "fs";
import path from "path";
import request from "supertest";
import type { Express } from "express";

// `lib/registry` throws at import time when PROJECT_REGISTRY_CONTRACT_ID is
// unset (as in CI). Mock it so the real app can be imported without env or RPC.
jest.mock("../lib/registry", () => {
  class RpcDegradedError extends Error {}
  class DuplicateSubmissionError extends Error {}
  class StaleSequenceError extends Error {}
  class ProjectNotFoundError extends Error {}
  return {
    RpcDegradedError,
    DuplicateSubmissionError,
    StaleSequenceError,
    ProjectNotFoundError,
    getLocalSequence: jest.fn(() => null),
    resetLocalSequence: jest.fn(),
    updateImpactScore: jest.fn(),
    getTotalProjects: jest.fn().mockResolvedValue(3),
    getScoreHistory: jest.fn().mockResolvedValue([]),
    getInterestRate: jest.fn().mockResolvedValue(5),
  };
});

const ADMIN_API_KEY = "route-table-admin-key";
const AUTH = { "X-API-Key": ADMIN_API_KEY };

let app: Express;

beforeAll(() => {
  process.env.ADMIN_API_KEY = ADMIN_API_KEY;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  app = (require("../index") as { default: Express }).default;
});

afterAll(() => {
  delete process.env.ADMIN_API_KEY;
});

/** True when the response is the `parseProjectId` 400, not a real route result. */
function isProjectIdError(res: { status: number; body: unknown }): boolean {
  const body = res.body as { error?: { code?: string; message?: string } };
  return (
    res.status === 400 &&
    body?.error?.code === "bad_request" &&
    typeof body.error.message === "string" &&
    body.error.message.toLowerCase().includes("project id")
  );
}

/** Concrete `/v1` GET paths documented in openapi.json plus API.md. */
function documentedGetPaths(): string[] {
  const specPath = path.join(__dirname, "..", "..", "openapi.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };

  const paths = Object.entries(spec.paths)
    .filter(([, operations]) => "get" in operations)
    .map(([p]) => p.replace(/\{[^}]+\}/g, "5"));

  // `/projects/aggregate` is documented in API.md (§ GET /v1/projects/aggregate)
  // but not yet present in the generated OpenAPI spec.
  if (!paths.includes("/projects/aggregate")) {
    paths.push("/projects/aggregate");
  }
  return paths;
}

describe("route table (#760)", () => {
  it("GET /v1/projects/aggregate resolves to the aggregate handler, not /:id", async () => {
    const res = await request(app).get("/v1/projects/aggregate").set(AUTH);
    expect(isProjectIdError(res)).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("total_projects");
  });

  it("GET /api/projects/aggregate resolves to the aggregate handler", async () => {
    const res = await request(app).get("/api/projects/aggregate").set(AUTH);
    expect(isProjectIdError(res)).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("total_projects");
  });

  it("GET /v1/projects/5 still reaches the project detail handler", async () => {
    const res = await request(app).get("/v1/projects/5").set(AUTH);
    expect(isProjectIdError(res)).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5 });
  });

  it("GET /v1/projects/5/history reaches the history handler", async () => {
    const res = await request(app).get("/v1/projects/5/history").set(AUTH);
    expect(isProjectIdError(res)).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ project_id: 5 });
  });

  it("GET /v1/projects/5/price-history reaches the price-history handler", async () => {
    const res = await request(app).get("/v1/projects/5/price-history").set(AUTH);
    expect(isProjectIdError(res)).toBe(false);
    expect(res.status).toBe(200);
  });

  it("no documented /v1 GET path resolves to a spurious project-id 400", async () => {
    const paths = documentedGetPaths();
    expect(paths.length).toBeGreaterThan(0);

    const spurious: string[] = [];
    for (const p of paths) {
      const res = await request(app).get(`/v1${p}`).set(AUTH);
      if (isProjectIdError(res)) {
        spurious.push(`${p} -> ${res.status} ${JSON.stringify(res.body)}`);
      }
    }

    expect(spurious).toEqual([]);
  });
});
