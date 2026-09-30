/**
 * HTTP route tests for `src/routes/projects.ts` (issue #679).
 *
 * The router is mounted on a minimal Express app together with the shared
 * `notFoundHandler`/`errorHandler`, mirroring `routes.test.ts`. The upstream
 * dependencies (registry, scoring, iot data) are mocked at the module boundary
 * so the assertions are deterministic and no DB/RPC is touched.
 *
 * NOTE: the real app serves this router at `/v1/projects` (and `/api/projects`);
 * this suite mounts it at `/v1/projects`. The mount prefix is not what is under
 * test — the handlers are.
 */
import request from "supertest";
import express, { Express } from "express";
import projectsRouter from "../routes/projects";
import { errorHandler, notFoundHandler } from "../middleware/errors";

jest.mock("../lib/registry", () => ({ getTotalProjects: jest.fn() }));
jest.mock("../lib/scoring", () => ({ computeScores: jest.fn() }));
jest.mock("../routes/iot", () => ({
  __esModule: true,
  default: jest.fn(),
  getSolarData: jest.fn(),
  getSatelliteData: jest.fn(),
  seededRandom: jest.fn(),
  getHourSeed: jest.fn(),
}));

import { getTotalProjects } from "../lib/registry";
import { computeScores } from "../lib/scoring";
import { getSolarData, getSatelliteData, seededRandom } from "../routes/iot";

const mockedTotal = getTotalProjects as jest.Mock;
const mockedScores = computeScores as jest.Mock;
const mockedSolar = getSolarData as jest.Mock;
const mockedSatellite = getSatelliteData as jest.Mock;
const mockedRandom = seededRandom as jest.Mock;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/projects", projectsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Deterministic fixtures: project id N → credit_quality 10N, green_impact N. */
function primeProjects(count = 3): void {
  mockedTotal.mockResolvedValue(count);
  mockedSolar.mockImplementation((id: number) => ({
    power_output_kw: id * 10,
    efficiency_pct: 50 + id,
    timestamp: 1000 + id,
  }));
  mockedSatellite.mockImplementation((id: number) => ({
    forest_density_pct: id,
    ndvi_score: id / 10,
    timestamp: 2000 + id,
  }));
  mockedScores.mockImplementation(({ solar, satellite }: { solar: any; satellite: any }) => ({
    credit_quality: solar.power_output_kw,
    green_impact: satellite.forest_density_pct,
  }));
  mockedRandom.mockReturnValue(0.5);
}

describe("GET /v1/projects (#679)", () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    primeProjects(3);
    app = buildApp();
  });

  it("returns the project list with totals", async () => {
    const res = await request(app).get("/v1/projects");

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(3);
    expect(res.body.total).toBe(3);
    expect(res.body.filtered_total).toBe(3);
    expect(res.body.projects.map((p: any) => p.id)).toEqual([1, 2, 3]);
  });

  it("paginates with limit and cursor", async () => {
    const first = await request(app).get("/v1/projects?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.projects).toHaveLength(2);
    expect(first.body.cursor).toBe(2);

    const second = await request(app).get("/v1/projects?limit=2&cursor=2");
    expect(second.status).toBe(200);
    expect(second.body.projects).toHaveLength(1);
    expect(second.body.cursor).toBeUndefined();
  });

  it("sorts by a sortable field in the requested direction", async () => {
    const desc = await request(app).get("/v1/projects?sort_by=credit_quality&sort_order=desc");
    expect(desc.status).toBe(200);
    expect(desc.body.projects.map((p: any) => p.credit_quality)).toEqual([30, 20, 10]);

    const asc = await request(app).get("/v1/projects?sort_by=credit_quality&sort_order=asc");
    expect(asc.body.projects.map((p: any) => p.credit_quality)).toEqual([10, 20, 30]);
  });

  it("includes computed scores on each project", async () => {
    const res = await request(app).get("/v1/projects");
    for (const p of res.body.projects) {
      expect(typeof p.credit_quality).toBe("number");
      expect(typeof p.green_impact).toBe("number");
    }
    expect(mockedScores).toHaveBeenCalled();
  });

  it("filters by min_score and reports filtered_total", async () => {
    const res = await request(app).get("/v1/projects?min_score=20");
    expect(res.status).toBe(200);
    expect(res.body.filtered_total).toBe(2);
    expect(res.body.projects.map((p: any) => p.id)).toEqual([2, 3]);
  });

  it("rejects an unknown sort field with 400", async () => {
    const res = await request(app).get("/v1/projects?sort_by=nope");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("rejects an invalid sort_order with 400", async () => {
    const res = await request(app).get("/v1/projects?sort_order=sideways");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("rejects a non-numeric limit with 400", async () => {
    const res = await request(app).get("/v1/projects?limit=abc");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("returns project detail with funding", async () => {
    const res = await request(app).get("/v1/projects/2");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(2);
    expect(res.body.credit_quality).toBe(20);
    expect(res.body.funding).toBe(500000); // seededRandom mocked to 0.5 * 1_000_000
  });

  it("rejects a non-numeric project id with 400", async () => {
    const res = await request(app).get("/v1/projects/not-a-number");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });
});
