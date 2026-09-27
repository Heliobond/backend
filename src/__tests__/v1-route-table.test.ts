import request from "supertest";
import express, { Express, NextFunction, Request, Response } from "express";
import { createV1Router } from "../v1Router";
import { notFoundHandler, errorHandler } from "../middleware/errors";
import * as registry from "../lib/registry";
import * as scoring from "../lib/scoring";

/**
 * Route-table regression test for the `/v1` surface.
 *
 * Two defects motivated this suite:
 *
 *  1. `routes/admin.ts` was mounted under the `/v1/admin/feature-flags/analytics`
 *     prefix, so the `POST /v1/admin/update-scores` and `GET /v1/admin/audit`
 *     paths documented in README.md/API.md could never resolve (#643).
 *  2. The `/v1` router was never attached to the app, so *every* path it
 *     registered fell through to the 404 handler.
 *
 * Fixing the prefix alone would therefore not have been enough, so the suite
 * asserts both: the documented admin paths resolve, and a representative sample
 * of the other `/v1` mounts is reachable too.
 */

// `apiKeyAuth` (applied to the public v1 mounts) falls back to the admin key.
process.env.ADMIN_API_KEY = "test-key";

// Every router except `admin` is replaced with a stub that answers only its own
// mount root. That keeps the suite focused on the route table instead of
// pulling in 23 unrelated dependency graphs: a 200 carrying `{ router: name }`
// proves the request travelled through the expected mount. Answering only "/"
// (rather than every path) is deliberate — a catch-all stub would shadow the
// nested mounts such as `/v1/projects/aggregate`.
function mockStubRouter(name: string) {
  // `jest.mock` factories are hoisted above the import block, so reach express
  // through `jest.requireActual` instead of a top-level import.
  const { Router } = jest.requireActual<typeof import("express")>("express");
  const router = Router();
  router.all("/", (_req: Request, res: Response) => res.json({ router: name }));
  return router;
}

jest.mock("../routes/iot", () => ({ __esModule: true, default: mockStubRouter("iot") }));
jest.mock("../routes/projects", () => ({ __esModule: true, default: mockStubRouter("projects") }));
jest.mock("../routes/portfolio", () => ({
  __esModule: true,
  default: mockStubRouter("portfolio"),
}));
jest.mock("../routes/roles", () => ({ __esModule: true, default: mockStubRouter("roles") }));
jest.mock("../routes/batch", () => ({ __esModule: true, default: mockStubRouter("batch") }));
jest.mock("../routes/webhooks", () => ({ __esModule: true, default: mockStubRouter("webhooks") }));
jest.mock("../routes/history", () => ({ __esModule: true, default: mockStubRouter("history") }));
jest.mock("../routes/panels", () => ({ __esModule: true, default: mockStubRouter("panels") }));
jest.mock("../routes/metadata", () => ({ __esModule: true, default: mockStubRouter("metadata") }));
jest.mock("../routes/dashboard", () => ({
  __esModule: true,
  default: mockStubRouter("dashboard"),
}));
jest.mock("../routes/email", () => ({ __esModule: true, default: mockStubRouter("email") }));
jest.mock("../routes/anomaly", () => ({ __esModule: true, default: mockStubRouter("anomaly") }));
jest.mock("../routes/scoring-formulas", () => ({
  __esModule: true,
  default: mockStubRouter("scoring-formulas"),
}));
jest.mock("../routes/chains", () => ({ __esModule: true, default: mockStubRouter("chains") }));
jest.mock("../routes/satellite-sources", () => ({
  __esModule: true,
  default: mockStubRouter("satellite-sources"),
}));
jest.mock("../routes/aggregate", () => ({
  __esModule: true,
  default: mockStubRouter("aggregate"),
}));
jest.mock("../routes/comparison", () => ({
  __esModule: true,
  default: mockStubRouter("comparison"),
}));
jest.mock("../routes/benchmarking", () => ({
  __esModule: true,
  default: mockStubRouter("benchmarking"),
}));
jest.mock("../routes/financial", () => ({
  __esModule: true,
  default: mockStubRouter("financial"),
}));
jest.mock("../routes/forecast", () => ({ __esModule: true, default: mockStubRouter("forecast") }));
jest.mock("../routes/maintenance", () => ({
  __esModule: true,
  default: mockStubRouter("maintenance"),
}));
jest.mock("../routes/investor", () => ({ __esModule: true, default: mockStubRouter("investor") }));
jest.mock("../routes/apiKeys", () => ({ __esModule: true, default: mockStubRouter("apiKeys") }));

// The rate limiters are process-wide singletons counting requests per IP. The
// suite issues a handful of admin calls, so they are bypassed to keep the
// assertions about routing rather than about the limiter's window.
jest.mock("../middleware/rateLimit", () => ({
  publicLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  adminLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock("../lib/registry", () => ({
  updateImpactScore: jest.fn(),
  getTotalProjects: jest.fn().mockResolvedValue(0),
  RpcDegradedError: class RpcDegradedError extends Error {},
}));
jest.mock("../lib/scoring");
jest.mock("../config", () => ({
  config: { ADMIN_API_KEY: "test-key", ADMIN_REQUEST_MAX_AGE_MS: 300_000 },
}));

/** Mirrors how `index.ts` assembles the app around the v1 router. */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/v1", createV1Router());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const AUTH_HEADER = { Authorization: "Bearer test-key" };

// `routes/admin.ts` requires a fresh `X-Request-Timestamp` on every call (added
// by #628), so the admin paths need it on top of the bearer token.
const ADMIN_HEADERS = {
  Authorization: "Bearer test-key",
  "X-Request-Timestamp": String(Date.now()),
};

describe("v1 route table", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    (registry.getTotalProjects as jest.Mock).mockResolvedValue(0);
    (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-hash");
    (scoring.computeScores as jest.Mock).mockReturnValue({
      credit_quality: 85,
      green_impact: 70,
    });
  });

  // ── #643: the documented admin paths must resolve ────────────────────────

  describe("documented admin endpoints", () => {
    it("resolves POST /v1/admin/update-scores", async () => {
      const res = await request(app)
        .post("/v1/admin/update-scores")
        .set(ADMIN_HEADERS)
        .send({ project_ids: [1] });

      // The assertion is about routing, not about the oracle: any status that
      // is not 404 proves the request reached the handler in `routes/admin.ts`.
      expect(res.status).not.toBe(404);
    });

    it("resolves GET /v1/admin/audit", async () => {
      const res = await request(app).get("/v1/admin/audit").set(ADMIN_HEADERS);

      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("entries");
    });

    it("reaches the admin router (401, not 404) when the bearer token is absent", async () => {
      const res = await request(app).post("/v1/admin/update-scores").send({});

      expect(res.status).not.toBe(404);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    });

    it("reaches the admin router (401, not 404) when the bearer token is wrong", async () => {
      const res = await request(app)
        .post("/v1/admin/update-scores")
        .set({ Authorization: "Bearer wrong-token" })
        .send({});

      expect(res.status).not.toBe(404);
      expect(res.status).toBe(401);
    });

    it("no longer serves the admin router under the feature-flag analytics prefix", async () => {
      // That is where the router used to live by mistake; keeping the path dead
      // is what makes the documented one authoritative.
      const res = await request(app)
        .post("/v1/admin/feature-flags/analytics/update-scores")
        .set(ADMIN_HEADERS)
        .send({});

      expect(res.status).toBe(404);
    });

    it("keeps the sibling admin mounts reachable under /v1/admin", async () => {
      // Mounting `adminRouter` under `/v1/admin` must not shadow the routers
      // that were already registered under the same prefix. These two mounts
      // are deliberately ordered before the broad `/admin` one, so they keep
      // their original auth contract: a bearer token is enough, no
      // `X-Request-Timestamp` required.
      const batch = await request(app).get("/v1/admin/batch").set(AUTH_HEADER).send();
      const apiKeys = await request(app).get("/v1/admin/api-keys").set(AUTH_HEADER).send();

      expect(batch.status).toBe(200);
      expect(batch.body).toEqual({ router: "batch" });
      expect(apiKeys.status).toBe(200);
      expect(apiKeys.body).toEqual({ router: "apiKeys" });
    });
  });

  // ── The `/v1` router must actually be mounted ────────────────────────────

  describe("v1 router is mounted", () => {
    const samples: Array<[string, string]> = [
      ["/v1/iot", "iot"],
      ["/v1/projects", "projects"],
      ["/v1/portfolio", "portfolio"],
      ["/v1/roles", "roles"],
      ["/v1/webhooks", "webhooks"],
      ["/v1/panels", "panels"],
      ["/v1/metadata", "metadata"],
      ["/v1/dashboards", "dashboard"],
      ["/v1/email", "email"],
      ["/v1/anomaly", "anomaly"],
      ["/v1/scoring/formulas", "scoring-formulas"],
      ["/v1/chains", "chains"],
      ["/v1/satellite-sources", "satellite-sources"],
      ["/v1/comparison", "comparison"],
      ["/v1/benchmarking", "benchmarking"],
      ["/v1/financial", "financial"],
      ["/v1/forecast", "forecast"],
      ["/v1/maintenance", "maintenance"],
      ["/v1/investor", "investor"],
    ];

    it.each(samples)("routes %s to its router", async (path, name) => {
      const res = await request(app).get(path).set(AUTH_HEADER).send();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ router: name });
    });

    it("keeps the nested /v1/projects mounts reachable", async () => {
      const history = await request(app).get("/v1/projects/1/history").set(AUTH_HEADER).send();
      const aggregate = await request(app).get("/v1/projects/aggregate").set(AUTH_HEADER).send();

      expect(history.status).toBe(200);
      expect(history.body).toEqual({ router: "history" });
      expect(aggregate.status).toBe(200);
      expect(aggregate.body).toEqual({ router: "aggregate" });
    });
  });
});
