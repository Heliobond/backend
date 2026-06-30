import request from "supertest";
import express from "express";
import { getHealth, getReadiness } from "../lib/health";

describe("Health and Readiness Endpoints", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.get("/health", (_req, res) => res.json(getHealth()));
    app.get("/ready", (_req, res) => {
      const readiness = getReadiness();
      res.status(readiness.status === "ready" ? 200 : 503).json(readiness);
    });
  });

  describe("GET /health", () => {
    it("should return 200 with health status", async () => {
      const response = await request(app).get("/health");
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "ok");
      expect(response.body).toHaveProperty("uptime_seconds");
      expect(response.body).toHaveProperty("started_at");
    });
  });

  describe("GET /ready", () => {
    it("should return 200 or 503 with readiness status", async () => {
      const response = await request(app).get("/ready");
      expect([200, 503]).toContain(response.status);
      expect(response.body).toHaveProperty("status");
      expect(response.body).toHaveProperty("checks");
      expect(response.body.checks).toHaveProperty("database");
      expect(response.body.checks).toHaveProperty("satellite");
    });
  });
});
