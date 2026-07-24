import request from "supertest";
import express, { Express } from "express";
import iotRouter from "../routes/iot";
import adminRouter from "../routes/admin";
import { getHealth } from "../lib/health";
import { errorHandler, notFoundHandler } from "../middleware/errors";
import * as registry from "../lib/registry";

// Factory mock avoids loading the real registry module, which throws at import
// time when PROJECT_REGISTRY_CONTRACT_ID is unset (e.g. in CI).
jest.mock("../lib/registry", () => ({
  updateImpactScore: jest.fn(),
  getTotalProjects: jest.fn(),
}));

const ADMIN_API_KEY = "test-key";
const authHeader = { Authorization: `Bearer ${ADMIN_API_KEY}` };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json(getHealth()));
  app.use("/api/iot", iotRouter);
  app.use("/api/admin", adminRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("HTTP integration", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;
    jest.clearAllMocks();
    (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-hash");
    (registry.getTotalProjects as jest.Mock).mockResolvedValue(2);
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  describe("GET /health", () => {
    it("returns status ok", async () => {
      const res = await request(app).get("/health").expect(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("GET /api/iot/solar/:id", () => {
    it("returns the expected shape for a valid id", async () => {
      const res = await request(app).get("/api/iot/solar/1").expect(200);
      expect(typeof res.body.power_output_kw).toBe("number");
      expect(typeof res.body.efficiency_pct).toBe("number");
      expect(typeof res.body.max_power_kw).toBe("number");
      expect(typeof res.body.timestamp).toBe("number");
    });

    it("returns 400 for a non-numeric id", async () => {
      const res = await request(app).get("/api/iot/solar/abc").expect(400);
      expect(res.body.error.code).toBe("bad_request");
    });

    it("returns 400 for id 0", async () => {
      const res = await request(app).get("/api/iot/solar/0").expect(400);
      expect(res.body.error.code).toBe("bad_request");
    });
  });

  describe("GET /api/iot/satellite/:id", () => {
    it("returns the expected shape for a valid id", async () => {
      const res = await request(app).get("/api/iot/satellite/1").expect(200);
      expect(typeof res.body.forest_density_pct).toBe("number");
      expect(typeof res.body.ndvi_score).toBe("number");
      expect(typeof res.body.timestamp).toBe("number");
    });

    it("returns 400 for a non-numeric id", async () => {
      const res = await request(app).get("/api/iot/satellite/abc").expect(400);
      expect(res.body.error.code).toBe("bad_request");
    });
  });

  describe("POST /api/admin/update-scores", () => {
    it("returns updated scores when authorized", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set(authHeader)
        .send({ project_ids: [1] })
        .expect(200);

      expect(res.body.updated).toBe(1);
      expect(res.body.results[0]).toMatchObject({ project_id: 1, tx_hash: "tx-hash" });
    });

    it("returns 401 without a bearer token", async () => {
      const res = await request(app).post("/api/admin/update-scores").send({}).expect(401);
      expect(res.body.error.code).toBe("unauthorized");
    });

    it("returns 500 when ADMIN_API_KEY is not configured", async () => {
      delete process.env.ADMIN_API_KEY;
      const res = await request(app).post("/api/admin/update-scores").send({}).expect(500);
      expect(res.body.error.code).toBe("server_misconfigured");
    });
  });
});
