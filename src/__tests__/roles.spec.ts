import request from "supertest";
import express, { Express } from "express";
import rolesRouter from "../routes/roles";
import { errorHandler } from "../middleware/errors";
import { assignRole } from "../lib/roles";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/roles", rolesRouter);
  app.use(errorHandler);
  return app;
}

describe("roles routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    // Seed an admin so tests can act as one
    assignRole("admin-user", "admin");
  });

  it("POST /api/roles — admin can assign a role", async () => {
    const res = await request(app)
      .post("/api/roles")
      .set("X-User-Id", "admin-user")
      .send({ userId: "alice", role: "operator" })
      .expect(201);
    expect(res.body).toEqual({ userId: "alice", role: "operator" });
  });

  it("POST /api/roles — rejects invalid role", async () => {
    await request(app)
      .post("/api/roles")
      .set("X-User-Id", "admin-user")
      .send({ userId: "bob", role: "superuser" })
      .expect(400);
  });

  it("POST /api/roles — viewer cannot assign roles (forbidden)", async () => {
    assignRole("viewer-user", "viewer");
    const res = await request(app)
      .post("/api/roles")
      .set("X-User-Id", "viewer-user")
      .send({ userId: "bob", role: "viewer" })
      .expect(403);
    expect(res.body).toEqual({
      error: {
        code: "forbidden",
        message: "This action requires the 'admin' role or higher",
      },
    });
  });

  it("POST /api/roles — unauthenticated request returns 401", async () => {
    const res = await request(app)
      .post("/api/roles")
      .send({ userId: "bob", role: "viewer" })
      .expect(401);
    expect(res.body).toEqual({
      error: { code: "unauthorized", message: "X-User-Id header is required" },
    });
  });

  it("GET /api/roles — admin lists all roles", async () => {
    assignRole("listed-user", "viewer");
    const res = await request(app).get("/api/roles").set("X-User-Id", "admin-user").expect(200);
    expect(res.body.roles).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: "listed-user", role: "viewer" })]),
    );
  });

  it("DELETE /api/roles/:userId — admin can revoke a role", async () => {
    assignRole("to-remove", "viewer");
    await request(app)
      .delete("/api/roles/to-remove")
      .set("X-User-Id", "admin-user")
      .expect(200)
      .expect({ removed: true });
  });

  it("DELETE /api/roles/:userId — 404 for non-existent user", async () => {
    await request(app).delete("/api/roles/ghost").set("X-User-Id", "admin-user").expect(404);
  });

  describe("RBAC Role-Based Access Control (Issue #273)", () => {
    it("admin:write key / role -> 200 on privileged operations", async () => {
      assignRole("write-admin", "admin");
      const res = await request(app)
        .post("/api/roles")
        .set("X-User-Id", "write-admin")
        .send({ userId: "charlie", role: "operator" });
      expect(res.status).toBe(201);
    });

    it("admin:read key / viewer role -> 403 when attempting write operations", async () => {
      assignRole("read-viewer", "viewer");
      const res = await request(app)
        .post("/api/roles")
        .set("X-User-Id", "read-viewer")
        .send({ userId: "dave", role: "operator" });
      expect(res.status).toBe(403);
    });

    it("no key / unauthenticated user -> 401 rejected", async () => {
      const res = await request(app).post("/api/roles").send({ userId: "eve", role: "operator" });
      expect(res.status).toBe(401);
    });

    it("invalid key / unassigned user -> 403 forbidden", async () => {
      const res = await request(app)
        .post("/api/roles")
        .set("X-User-Id", "unknown-user")
        .send({ userId: "eve", role: "operator" });
      expect(res.status).toBe(403);
    });
  });
});
