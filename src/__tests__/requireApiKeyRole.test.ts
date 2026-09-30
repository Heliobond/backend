import express from "express";
import request from "supertest";
import {
  extractApiKeyRole,
  requireApiKeyRole,
  requireApiKeyAuth,
} from "../middleware/requireApiKeyRole";
import * as apiKeyRoles from "../lib/apiKeyRoles";

jest.mock("../lib/apiKeyRoles");

describe("requireApiKeyRole middleware", () => {
  const mockGetApiKeyRole = apiKeyRoles.getApiKeyRole as jest.MockedFunction<
    typeof apiKeyRoles.getApiKeyRole
  >;
  const mockHasRolePermission = apiKeyRoles.hasRolePermission as jest.MockedFunction<
    typeof apiKeyRoles.hasRolePermission
  >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("extractApiKeyRole middleware", () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(extractApiKeyRole);
      app.get("/test", (req, res) => {
        res.json({ role: req.apiKeyRole || null });
      });
    });

    it("should extract role from valid Bearer token", async () => {
      mockGetApiKeyRole.mockReturnValue("admin:write");

      const res = await request(app).get("/test").set("Authorization", "Bearer test-token");

      expect(res.status).toBe(200);
      expect(res.body.role).toBe("admin:write");
      expect(mockGetApiKeyRole).toHaveBeenCalledWith("test-token");
    });

    it("should not set role when no Authorization header is present", async () => {
      const res = await request(app).get("/test");

      expect(res.status).toBe(200);
      expect(res.body.role).toBeNull();
      expect(mockGetApiKeyRole).not.toHaveBeenCalled();
    });

    it("should not set role when Authorization header is not Bearer format", async () => {
      const res = await request(app).get("/test").set("Authorization", "Basic dXNlcjpwYXNz");

      expect(res.status).toBe(200);
      expect(res.body.role).toBeNull();
      expect(mockGetApiKeyRole).not.toHaveBeenCalled();
    });

    it("should not set role when Bearer token is invalid", async () => {
      mockGetApiKeyRole.mockReturnValue(undefined);

      const res = await request(app).get("/test").set("Authorization", "Bearer invalid-token");

      expect(res.status).toBe(200);
      expect(res.body.role).toBeNull();
      expect(mockGetApiKeyRole).toHaveBeenCalledWith("invalid-token");
    });

    it("should not set role when Bearer token is empty", async () => {
      const res = await request(app).get("/test").set("Authorization", "Bearer ");

      expect(res.status).toBe(200);
      expect(res.body.role).toBeNull();
      expect(mockGetApiKeyRole).not.toHaveBeenCalled();
    });
  });

  describe("requireApiKeyRole middleware", () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(extractApiKeyRole);
      app.get("/admin-write", requireApiKeyRole("admin:write"), (req, res) => {
        res.json({ success: true });
      });
      app.get("/admin-read", requireApiKeyRole("admin:read"), (req, res) => {
        res.json({ success: true });
      });
      app.get("/iot-read", requireApiKeyRole("iot:read"), (req, res) => {
        res.json({ success: true });
      });
    });

    it("should allow request when user has required role", async () => {
      mockGetApiKeyRole.mockReturnValue("admin:write");
      mockHasRolePermission.mockReturnValue(true);

      const res = await request(app).get("/admin-write").set("Authorization", "Bearer admin-token");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockHasRolePermission).toHaveBeenCalledWith("admin:write", "admin:write");
    });

    it("should allow admin:write role to access admin:read endpoints", async () => {
      mockGetApiKeyRole.mockReturnValue("admin:write");
      mockHasRolePermission.mockReturnValue(true);

      const res = await request(app).get("/admin-read").set("Authorization", "Bearer admin-token");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockHasRolePermission).toHaveBeenCalledWith("admin:write", "admin:read");
    });

    it("should return 403 when user lacks required role", async () => {
      mockGetApiKeyRole.mockReturnValue("admin:read");
      mockHasRolePermission.mockReturnValue(false);

      const res = await request(app)
        .get("/admin-write")
        .set("Authorization", "Bearer read-only-token");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
      expect(res.body.message).toBe("This action requires the 'admin:write' role or higher");
      expect(mockHasRolePermission).toHaveBeenCalledWith("admin:read", "admin:write");
    });

    it("should return 403 when no role is set on request", async () => {
      mockGetApiKeyRole.mockReturnValue(undefined);
      mockHasRolePermission.mockReturnValue(false);

      const res = await request(app)
        .get("/admin-write")
        .set("Authorization", "Bearer invalid-token");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
      expect(mockHasRolePermission).toHaveBeenCalledWith(undefined, "admin:write");
    });

    it("should return 403 when no Authorization header is present", async () => {
      mockHasRolePermission.mockReturnValue(false);

      const res = await request(app).get("/admin-write");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
      expect(mockHasRolePermission).toHaveBeenCalledWith(undefined, "admin:write");
    });

    it("should enforce different role requirements for iot:read", async () => {
      mockGetApiKeyRole.mockReturnValue("iot:read");
      mockHasRolePermission.mockReturnValue(true);

      const res = await request(app).get("/iot-read").set("Authorization", "Bearer iot-token");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockHasRolePermission).toHaveBeenCalledWith("iot:read", "iot:read");
    });
  });

  describe("requireApiKeyAuth middleware", () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(extractApiKeyRole);
      app.get("/protected", requireApiKeyAuth, (req, res) => {
        res.json({ success: true, role: req.apiKeyRole });
      });
    });

    it("should allow request with any valid role", async () => {
      mockGetApiKeyRole.mockReturnValue("admin:read");

      const res = await request(app).get("/protected").set("Authorization", "Bearer valid-token");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.role).toBe("admin:read");
    });

    it("should return 401 when no valid token is provided", async () => {
      mockGetApiKeyRole.mockReturnValue(undefined);

      const res = await request(app).get("/protected").set("Authorization", "Bearer invalid-token");

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
      expect(res.body.message).toBe("Missing or invalid bearer token");
    });

    it("should return 401 when no Authorization header is present", async () => {
      const res = await request(app).get("/protected");

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
      expect(res.body.message).toBe("Missing or invalid bearer token");
    });
  });
});
