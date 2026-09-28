import request from "supertest";
import express from "express";
import { identifyUser, requireAuth, requireRole } from "../middleware/rbac";
import * as rolesLib from "../lib/roles";

jest.mock("../lib/roles", () => {
  return {
    hasPermission: jest.fn(),
    listRoles: jest.fn(),
  };
});

describe("RBAC middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    
    app.get("/identify", identifyUser, (req, res) => {
      res.json({ userId: req.userId });
    });

    app.get("/auth", identifyUser, requireAuth, (req, res) => {
      res.json({ ok: true });
    });

    app.get("/admin", identifyUser, requireRole("admin"), (req, res) => {
      res.json({ ok: true });
    });
  });

  describe("identifyUser", () => {
    it("should set req.userId if X-User-Id header is present and valid (happy path)", async () => {
      const res = await request(app)
        .get("/identify")
        .set("X-User-Id", "user-123");
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe("user-123");
    });

    it("should not set req.userId if X-User-Id header is missing (edge case)", async () => {
      const res = await request(app).get("/identify");
      expect(res.status).toBe(200);
      expect(res.body.userId).toBeUndefined();
    });

    it("should not set req.userId if X-User-Id header is empty (edge case)", async () => {
      const res = await request(app)
        .get("/identify")
        .set("X-User-Id", "   ");
      expect(res.status).toBe(200);
      expect(res.body.userId).toBeUndefined();
    });
  });

  describe("requireAuth", () => {
    it("should allow request if user is identified (happy path)", async () => {
      const res = await request(app)
        .get("/auth")
        .set("X-User-Id", "user-123");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("should reject request with 401 if user is not identified (edge case)", async () => {
      const res = await request(app).get("/auth");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
      expect(res.body.message).toBe("X-User-Id header is required");
    });
  });

  describe("requireRole", () => {
    it("should allow request if no roles exist yet (bootstrap mode - happy path)", async () => {
      (rolesLib.listRoles as jest.Mock).mockReturnValue([]);
      
      const res = await request(app)
        .get("/admin")
        .set("X-User-Id", "user-123");
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("should allow request if user has the required permission (happy path)", async () => {
      (rolesLib.listRoles as jest.Mock).mockReturnValue([{ userId: "admin-1", role: "admin" }]);
      (rolesLib.hasPermission as jest.Mock).mockReturnValue(true);
      
      const res = await request(app)
        .get("/admin")
        .set("X-User-Id", "admin-1");
      
      expect(rolesLib.hasPermission).toHaveBeenCalledWith("admin-1", "admin");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("should reject request with 403 if user lacks the required permission (edge case)", async () => {
      (rolesLib.listRoles as jest.Mock).mockReturnValue([{ userId: "admin-1", role: "admin" }]);
      (rolesLib.hasPermission as jest.Mock).mockReturnValue(false);
      
      const res = await request(app)
        .get("/admin")
        .set("X-User-Id", "user-123");
      
      expect(rolesLib.hasPermission).toHaveBeenCalledWith("user-123", "admin");
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    it("should reject request with 403 if roles exist but user is not identified (edge case)", async () => {
      (rolesLib.listRoles as jest.Mock).mockReturnValue([{ userId: "admin-1", role: "admin" }]);
      
      const res = await request(app).get("/admin");
      
      expect(rolesLib.hasPermission).not.toHaveBeenCalled();
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });
  });
});
