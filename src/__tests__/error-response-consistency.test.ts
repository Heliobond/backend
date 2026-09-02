import request from "supertest";
import express, { Express } from "express";
import adminRouter from "../routes/admin";
import iotRouter from "../routes/iot";
import { errorHandler } from "../middleware/errors";
import { getHealth } from "../lib/health";

jest.mock("../lib/registry", () => ({
  updateImpactScore: jest.fn(),
  getTotalProjects: jest.fn(),
}));
jest.mock("../lib/scoring");
jest.mock("../config", () => ({
  config: {
    ADMIN_API_KEY: "test-key",
  },
}));

function buildAdminApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use(errorHandler);
  return app;
}

function buildIotApp(): Express {
  const app = express();
  app.use("/api/iot", iotRouter);
  app.use(errorHandler);
  return app;
}

describe("error response consistency", () => {
  it("returns a structured error body for IoT validation failures", async () => {
    const app = buildIotApp();

    const res = await request(app).get("/api/iot/solar/not-a-number").expect(400);

    expect(res.body).toEqual({
      error: {
        code: "bad_request",
        message: expect.stringContaining("positive integer"),
      },
    });
  });

  it("returns a structured error body for admin authentication failures", async () => {
    const app = buildAdminApp();

    const res = await request(app).post("/api/admin/update-scores").send({}).expect(401);

    expect(res.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token",
      },
    });
  });

  it("returns a structured error body for admin server misconfiguration failures", async () => {
    const app = buildAdminApp();
    const configModule = jest.requireMock("../config") as { config: { ADMIN_API_KEY: string } };
    const original = configModule.config.ADMIN_API_KEY;
    configModule.config.ADMIN_API_KEY = "";

    try {
      const res = await request(app).post("/api/admin/update-scores").send({}).expect(500);
      expect(res.body).toEqual({
        error: {
          code: "server_misconfigured",
          message: "Admin API key is not configured",
        },
      });
    } finally {
      configModule.config.ADMIN_API_KEY = original;
    }
  });

  it("does not add an error property to the health check payload", async () => {
    const app = express();
    app.get("/health", async (_req, res) => res.json(await getHealth()));

    const res = await request(app).get("/health").expect(200);

    expect(res.body).not.toHaveProperty("error");
    expect(res.body.status).toBe("ok");
  });
});
