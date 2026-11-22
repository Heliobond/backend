/**
 * Contract tests for the projects list/detail API (#768).
 *
 * The interfaces below mirror the frontend's `PaginatedProjectsResponse` and
 * `ProjectWithDetail` types (Heliobond/frontend `src/lib/api.ts`), so a change
 * to the backend response shape fails here before it breaks the app.
 *
 * The registry is mocked: `getTotalProjects` backs the list and
 * `projectExists` (the contract's `get_project`) backs the detail 404.
 */

import request from "supertest";
import express, { Express } from "express";

jest.mock("../lib/registry", () => ({
  getTotalProjects: jest.fn(),
  projectExists: jest.fn(),
}));

import projectsRouter from "../routes/projects";
import { errorHandler } from "../middleware/errors";
import { getTotalProjects, projectExists } from "../lib/registry";
import { openApiSpec } from "../lib/swagger";

// Registers `toSatisfySchemaInApiSpec`, tying the runtime shapes to the
// exported OpenAPI components the frontend types are generated from.
import initOpenApiValidator from "jest-openapi";
initOpenApiValidator(openApiSpec as never);

/** Mirrors Heliobond/frontend `BackendProject` rows inside `PaginatedProjectsResponse`. */
interface BackendProject {
  id: number;
  credit_quality: number;
  green_impact: number;
  power_output_kw: number;
  efficiency_pct: number;
  forest_density_pct: number;
  ndvi_score: number;
  timestamp: number;
}

/** Mirrors Heliobond/frontend `PaginatedProjectsResponse`. */
interface PaginatedProjectsResponse {
  projects: BackendProject[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Mirrors Heliobond/frontend `ProjectWithDetail`. */
interface ProjectWithDetail {
  project: { id: number; credit_quality: number; green_impact: number };
  detail: {
    power_output_kw: number;
    efficiency_pct: number;
    forest_density_pct: number;
    ndvi_score: number;
    timestamp: number;
    funding: number;
  };
  verifiedMetadata: boolean;
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/projects", projectsRouter);
  app.use(errorHandler);
  return app;
}

function expectPaginatedShape(body: PaginatedProjectsResponse): void {
  expect(Array.isArray(body.projects)).toBe(true);
  expect(typeof body.total).toBe("number");
  expect(typeof body.page).toBe("number");
  expect(typeof body.pageSize).toBe("number");
  expect(typeof body.hasMore).toBe("boolean");

  for (const project of body.projects) {
    expect(typeof project.id).toBe("number");
    expect(typeof project.credit_quality).toBe("number");
    expect(typeof project.green_impact).toBe("number");
    expect(typeof project.power_output_kw).toBe("number");
    expect(typeof project.efficiency_pct).toBe("number");
    expect(typeof project.forest_density_pct).toBe("number");
    expect(typeof project.ndvi_score).toBe("number");
    expect(typeof project.timestamp).toBe("number");
  }
}

function expectProjectWithDetailShape(body: ProjectWithDetail): void {
  expect(Object.keys(body).sort()).toEqual(["detail", "project", "verifiedMetadata"]);

  expect(typeof body.project.id).toBe("number");
  expect(typeof body.project.credit_quality).toBe("number");
  expect(typeof body.project.green_impact).toBe("number");

  expect(typeof body.detail.power_output_kw).toBe("number");
  expect(typeof body.detail.efficiency_pct).toBe("number");
  expect(typeof body.detail.forest_density_pct).toBe("number");
  expect(typeof body.detail.ndvi_score).toBe("number");
  expect(typeof body.detail.timestamp).toBe("number");
  expect(typeof body.detail.funding).toBe("number");

  expect(typeof body.verifiedMetadata).toBe("boolean");
}

describe("GET /v1/projects — frontend PaginatedProjectsResponse contract (#768)", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    (getTotalProjects as jest.Mock).mockResolvedValue(3);
    (projectExists as jest.Mock).mockResolvedValue(true);
  });

  it("returns {projects,total,page,pageSize,hasMore} for page/pageSize", async () => {
    const res = await request(app).get("/v1/projects?page=1&pageSize=2").expect(200);
    const body = res.body as PaginatedProjectsResponse;

    expectPaginatedShape(body);
    expect(body).toSatisfySchemaInApiSpec("PaginatedProjectsResponse");
    expect(body.projects).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(2);
    expect(body.hasMore).toBe(true);
  });

  it("advances the page and clears hasMore on the last page", async () => {
    const res = await request(app).get("/v1/projects?page=2&pageSize=2").expect(200);
    const body = res.body as PaginatedProjectsResponse;

    expectPaginatedShape(body);
    expect(body.projects).toHaveLength(1);
    expect(body.page).toBe(2);
    expect(body.hasMore).toBe(false);
  });

  it("keeps cursor as a working alias while returning the new keys", async () => {
    const first = await request(app).get("/v1/projects?cursor=0&limit=2").expect(200);
    const firstBody = first.body as PaginatedProjectsResponse & { cursor?: number };

    expectPaginatedShape(firstBody);
    expect(firstBody.projects).toHaveLength(2);
    expect(firstBody.pageSize).toBe(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.cursor).toBe(2);

    const second = await request(app).get("/v1/projects?cursor=2&limit=2").expect(200);
    const secondBody = second.body as PaginatedProjectsResponse & { cursor?: number };

    expectPaginatedShape(secondBody);
    expect(secondBody.projects).toHaveLength(1);
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.cursor).toBeUndefined();
  });

  it("clamps pageSize to the 100 maximum", async () => {
    (getTotalProjects as jest.Mock).mockResolvedValue(150);

    const res = await request(app).get("/v1/projects?pageSize=500").expect(200);
    const body = res.body as PaginatedProjectsResponse;

    expect(body.pageSize).toBe(100);
    expect(body.projects).toHaveLength(100);
    expect(body.hasMore).toBe(true);
  });
});

describe("GET /v1/projects/:id — frontend ProjectWithDetail contract (#768)", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    (projectExists as jest.Mock).mockResolvedValue(true);
  });

  it("returns the nested {project,detail,verifiedMetadata} shape for known ids", async () => {
    const res = await request(app).get("/v1/projects/1").expect(200);
    expectProjectWithDetailShape(res.body as ProjectWithDetail);
    expect(res.body).toSatisfySchemaInApiSpec("ProjectWithDetail");
    expect((res.body as ProjectWithDetail).project.id).toBe(1);
    expect(projectExists).toHaveBeenCalledWith(1);
  });

  it("returns 404 not_found for ids the registry does not know", async () => {
    (projectExists as jest.Mock).mockResolvedValue(false);

    const res = await request(app).get("/v1/projects/999999").expect(404);
    expect(res.body.error.code).toBe("not_found");
    expect(projectExists).toHaveBeenCalledWith(999999);
  });

  it("returns 404 for deleted projects absent from the registry", async () => {
    (projectExists as jest.Mock).mockResolvedValue(false);

    const res = await request(app).get("/v1/projects/7").expect(404);
    expect(res.body.error.code).toBe("not_found");
  });
});
