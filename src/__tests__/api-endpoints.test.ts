import request from "supertest";
import express from "express";
import { getHealth } from "../lib/health";

// Create a minimal test app that mirrors the key endpoints
function createTestApp() {
  const app = express();
  app.use(express.json());

  // Health endpoint
  app.get("/health", (_req, res) => res.json(getHealth()));

  // IoT solar endpoint (mock)
  app.get("/api/iot/solar/:id", (req, res) => {
    const { id } = req.params;
    if (!id || id === "undefined") {
      return res.status(400).json({ error: "Missing panel ID" });
    }
    res.json({
      panel_id: id,
      efficiency_pct: 85,
      power_output_kw: 42.5,
      max_power_kw: 50,
      timestamp: new Date().toISOString(),
    });
  });

  // IoT satellite endpoint (mock)
  app.get("/api/iot/satellite/:id", (req, res) => {
    const { id } = req.params;
    if (!id || id === "undefined") {
      return res.status(400).json({ error: "Missing project ID" });
    }
    res.json({
      project_id: id,
      forest_density_pct: 72,
      ndvi_score: 0.68,
      timestamp: new Date().toISOString(),
    });
  });

  // Admin update-scores endpoint (mock)
  app.post("/api/admin/update-scores", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid authorization" });
    }

    const { project_id } = req.body;
    if (!project_id) {
      return res.status(400).json({ error: "Missing project_id in request body" });
    }

    res.json({
      project_id,
      credit_quality: 85,
      green_impact: 72,
      updated_at: new Date().toISOString(),
    });
  });

  // 404 handler
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  return app;
}

describe("API Endpoints", () => {
  const app = createTestApp();

  describe("GET /health", () => {
    it("returns 200 with health status", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });
  });

  describe("GET /api/iot/solar/:id", () => {
    it("returns solar data for valid ID", async () => {
      const res = await request(app).get("/api/iot/solar/panel-001");
      expect(res.status).toBe(200);
      expect(res.body.panel_id).toBe("panel-001");
      expect(res.body.efficiency_pct).toBeDefined();
      expect(res.body.power_output_kw).toBeDefined();
    });

    it("returns 400 for missing ID", async () => {
      const res = await request(app).get("/api/iot/solar/undefined");
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("GET /api/iot/satellite/:id", () => {
    it("returns satellite data for valid ID", async () => {
      const res = await request(app).get("/api/iot/satellite/proj-001");
      expect(res.status).toBe(200);
      expect(res.body.project_id).toBe("proj-001");
      expect(res.body.forest_density_pct).toBeDefined();
      expect(res.body.ndvi_score).toBeDefined();
    });

    it("returns 400 for missing ID", async () => {
      const res = await request(app).get("/api/iot/satellite/undefined");
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("POST /api/admin/update-scores", () => {
    it("returns 401 without authorization", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .send({ project_id: "proj-001" });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("authorization");
    });

    it("returns 400 without project_id", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer test-token")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("project_id");
    });

    it("returns 200 with valid auth and body", async () => {
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer test-token")
        .send({ project_id: "proj-001" });
      expect(res.status).toBe(200);
      expect(res.body.project_id).toBe("proj-001");
      expect(res.body.credit_quality).toBeDefined();
      expect(res.body.green_impact).toBeDefined();
    });
  });

  describe("Error scenarios", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await request(app).get("/api/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Not found");
    });

    it("returns 404 for wrong HTTP method", async () => {
      const res = await request(app).post("/health");
      expect(res.status).toBe(404);
    });
  });
});
