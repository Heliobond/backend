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
    await request(app)
      .post("/api/roles")
      .set("X-User-Id", "viewer-user")
      .send({ userId: "bob", role: "viewer" })
      .expect(403);
  });

  it("POST /api/roles — unauthenticated request returns 401", async () => {
    await request(app)
      .post("/api/roles")
      .send({ userId: "bob", role: "viewer" })
      .expect(401);
  });

  it("GET /api/roles — admin lists all roles", async () => {
    assignRole("listed-user", "viewer");
    const res = await request(app)
      .get("/api/roles")
      .set("X-User-Id", "admin-user")
      .expect(200);
    expect(res.body.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "listed-user", role: "viewer" }),
    ]));
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
    await request(app)
      .delete("/api/roles/ghost")
      .set("X-User-Id", "admin-user")
      .expect(404);
  });
});
