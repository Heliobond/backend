/**
 * Contract tests - validate that the OpenAPI spec can be used to generate a valid client
 * and that the spec structure is comprehensive. Uses jest-openapi matchers for
 * schema validation.
 */

import { openApiSpec } from "../lib/swagger";

// Initialize jest-openapi with the spec
// This extends Jest matchers with toSatisfySchemaInApiSpec()
import initOpenApiValidator from "jest-openapi";
initOpenApiValidator(openApiSpec as any);

describe("OpenAPI Spec Contract Tests", () => {
  describe("Schema validation", () => {
    it("should validate Project schema", () => {
      const project = {
        id: 1,
        name: "Test Project",
        credit_quality: 0.85,
        green_impact: 0.92,
      };
      expect(project).toSatisfySchemaInApiSpec("Project");
    });

    it("should validate Error schema", () => {
      const error = { error: "Not found" };
      expect(error).toSatisfySchemaInApiSpec("Error");
    });

    it("should validate BatchJob schema", () => {
      const batchJob = {
        id: "batch-123",
        status: "pending",
        total: 100,
        completed: 0,
        failed: 0,
        started_at: Date.now(),
        finished_at: null,
      };
      expect(batchJob).toSatisfySchemaInApiSpec("BatchJob");
    });

    it("should validate Role schema", () => {
      const role = {
        userId: "user-123",
        role: "admin",
      };
      expect(role).toSatisfySchemaInApiSpec("Role");
    });

    it("should validate Trend schema", () => {
      const trend = {
        trend: "improving",
        net_delta: 0.05,
        data_points: 10,
      };
      expect(trend).toSatisfySchemaInApiSpec("Trend");
    });

    it("should validate Webhook schema", () => {
      const webhook = {
        id: "webhook-123",
        url: "https://example.com/webhook",
        secret: "secret-123",
      };
      expect(webhook).toSatisfySchemaInApiSpec("Webhook");
    });
  });

  describe("Spec completeness", () => {
    it("should have all expected paths documented", () => {
      const documentedPaths = new Set(Object.keys(openApiSpec.paths));
      const expectedPaths = [
        "/iot/solar/{projectId}",
        "/iot/satellite/{projectId}",
        "/projects",
        "/projects/{id}",
        "/projects/{id}/history",
        "/projects/{id}/history/trend",
        "/portfolio",
        "/admin/score-update",
        "/admin/batch/score-update",
        "/admin/batch/{batchId}/status",
        "/roles",
        "/roles/{userId}",
        "/webhooks",
        "/webhooks/{id}",
      ];

      expectedPaths.forEach((path) => {
        expect(documentedPaths.has(path)).toBe(true);
      });
    });

    it("should have response schemas for all documented endpoints", () => {
      Object.entries(openApiSpec.paths).forEach(([path, methods]) => {
        Object.entries(methods).forEach(([method, operation]: [string, any]) => {
          const responses = operation.responses || {};
          const hasSuccessResponse = Object.keys(responses).some(
            (code) => code.startsWith("2") || code === "default",
          );
          expect(hasSuccessResponse).toBe(true);
        });
      });
    });

    it("should have security schemes defined for admin endpoints", () => {
      const paths = openApiSpec.paths as Record<string, Record<string, any>>;
      const adminOps = Object.entries(paths)
        .filter(([p]) => p.includes("admin"))
        .flatMap(([, methods]) => Object.values(methods));

      adminOps.forEach((op: any) => {
        expect(op.security).toBeDefined();
        expect(Array.isArray(op.security)).toBe(true);
      });
    });

    it("should have operation summaries for all endpoints", () => {
      Object.entries(openApiSpec.paths).forEach(([path, methods]) => {
        Object.entries(methods).forEach(([method, operation]: [string, any]) => {
          expect(operation.summary).toBeDefined();
          expect(typeof operation.summary).toBe("string");
          expect(operation.summary.length).toBeGreaterThan(0);
        });
      });
    });
  });

  describe("Spec version consistency", () => {
    it("should have a valid semantic version", () => {
      expect(openApiSpec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("should declare OpenAPI 3.x version", () => {
      expect(openApiSpec.openapi).toMatch(/^3\.\d+\.\d+$/);
    });
  });
});
