/**
 * @jest-environment node
 */
process.env.PROJECT_REGISTRY_CONTRACT_ID = "CCJZK7ZYK5N4T6Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5";

import request from "supertest";
import express, { Express } from "express";
import adminRouter from "../routes/admin";
import { errorHandler } from "../middleware/errors";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";

jest.mock("../lib/registry", () => ({
  getTotalProjects: jest.fn(),
}));
jest.mock("../lib/scoreService", () => ({
  updateScoreForProject: jest.fn(),
  resetIdempotencyState: jest.fn(),
}));
jest.mock("../routes/iot");
jest.mock("../lib/scoring");
jest.mock("../lib/apiKeyRoles", () => ({
  getApiKeyRole: jest.fn((key: string) => {
    if (key === "test-key") return "admin:write";
    return undefined;
  }),
  hasRolePermission: jest.fn((userRole: any, requiredRole: any) => {
    if (!userRole) return false;
    if (userRole === "admin:write")
      return requiredRole === "admin:read" || requiredRole === "admin:write";
    return userRole === requiredRole;
  }),
}));
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

describe("Security - injection attacks", () => {
  describe("Admin routes - prototype pollution attempts", () => {
    let scoreService: { updateScoreForProject: jest.Mock };

    beforeEach(() => {
      jest.clearAllMocks();
      scoreService = jest.requireMock("../lib/scoreService");
      scoreService.updateScoreForProject.mockResolvedValue({
        status: "success",
        creditQuality: 85,
        greenImpact: 70,
        txHash: "tx-hash-pp",
      });
      (registry.getTotalProjects as jest.Mock).mockResolvedValue(2);
    });

    it("__proto__ pollution → handled safely (falls through to all projects)", async () => {
      const app = buildAdminApp();
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer test-key")
        .send(JSON.parse('{"__proto__": {"project_ids": [999]}}'))
        .expect(200);

      expect(res.body.updated).toBe(2);
      expect(registry.getTotalProjects).toHaveBeenCalled();
    });

    it("constructor.prototype pollution → handled safely", async () => {
      const app = buildAdminApp();
      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer test-key")
        .send({ constructor: { prototype: { project_ids: [999] } } })
        .expect(200);

      expect(res.body.updated).toBe(2);
      expect(registry.getTotalProjects).toHaveBeenCalled();
    });
  });
});
