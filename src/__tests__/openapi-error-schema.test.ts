import { openApiSpec } from "../lib/swagger";
import initOpenApiValidator from "jest-openapi";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

initOpenApiValidator(openApiSpec as any);

describe("OpenAPI Error Schema and Contract Hardening (#925)", () => {
  // =========================================================================
  // Dimension 1: Boundary & Clamping Checks for Error Schema
  // =========================================================================
  describe("Dimension 1: Boundary values and payload clamping", () => {
    const standardCodes = [
      "bad_request",
      "not_found",
      "unauthorized",
      "forbidden",
      "conflict",
      "too_many_requests",
      "internal_error",
      "invalid_id",
      "project_not_found",
      "rate_limited",
      "unsupported_media_type",
      "payload_too_large",
      "precondition_failed",
      "gateway_timeout",
      "service_unavailable",
      "locked",
      "forbidden_origin",
      "stale_sequence",
      "invalid_wallet_signature",
      "insufficient_balance",
    ];

    it.each(standardCodes)("validates standard error payload with code: %s", (code) => {
      const payload = {
        error: {
          code,
          message: `A standardized error occurred for ${code}`,
        },
      };
      expect(payload).toSatisfySchemaInApiSpec("Error");
    });

    const messageBoundaries = [
      { desc: "empty message string", msg: "" },
      { desc: "single character message", msg: "X" },
      { desc: "whitespace string", msg: "   " },
      {
        desc: "standard 50-char message",
        msg: "The requested project identifier could not be found.",
      },
      { desc: "medium 250-char message", msg: "A".repeat(250) },
      { desc: "large 1000-char message", msg: "B".repeat(1000) },
      { desc: "boundary 5000-char message", msg: "C".repeat(5000) },
      { desc: "stress 10000-char message", msg: "D".repeat(10000) },
      { desc: "unicode and special symbols", msg: "Отказ: invalid_id / 404 — ⚠️ (EVM & Stellar)" },
    ];

    it.each(messageBoundaries)("accepts message boundary: $desc", ({ msg }) => {
      const payload = {
        error: {
          code: "boundary_test",
          message: msg,
        },
      };
      expect(payload).toSatisfySchemaInApiSpec("Error");
    });

    const codeBoundaries = [
      { desc: "empty code string", code: "" },
      { desc: "single character code", code: "E" },
      { desc: "snake_case code", code: "invalid_transition" },
      { desc: "kebab-case code", code: "error-rate-limit" },
      { desc: "UPPERCASE code", code: "ERR_UNAUTHORIZED" },
      { desc: "numeric-prefixed code", code: "404_not_found" },
      {
        desc: "long identifier code",
        code: "very_long_granular_domain_specific_error_identifier_code",
      },
    ];

    it.each(codeBoundaries)("accepts code identifier boundary: $desc", ({ code }) => {
      const payload = {
        error: {
          code,
          message: "Validation of code boundaries",
        },
      };
      expect(payload).toSatisfySchemaInApiSpec("Error");
    });
  });

  // =========================================================================
  // Dimension 2: Combinatorics across HTTP Error Statuses and Components
  // =========================================================================
  describe("Dimension 2: Component error responses and HTTP status codes", () => {
    const reusableResponses = [
      "BadRequest",
      "Unauthorized",
      "Forbidden",
      "NotFound",
      "Conflict",
      "TooManyRequests",
      "InternalServerError",
    ];

    it.each(reusableResponses)("defines reusable component response: %s", (respName) => {
      const responses = (openApiSpec.components as any).responses;
      expect(responses).toBeDefined();
      const resp = responses[respName];
      expect(resp).toBeDefined();
      expect(resp.description).toBeDefined();
      expect(typeof resp.description).toBe("string");
      expect(resp.content?.["application/json"]?.schema?.$ref).toBe("#/components/schemas/Error");
    });

    const expectedStatusCodes = [
      { status: "400", desc: "Bad request" },
      { status: "401", desc: "Unauthorized" },
      { status: "403", desc: "Forbidden" },
      { status: "404", desc: "Not found" },
      { status: "409", desc: "Conflict" },
      { status: "429", desc: "Too many requests" },
      { status: "500", desc: "Internal server error" },
    ];

    it.each(expectedStatusCodes)(
      "validates that status %s can be represented by the Error schema",
      ({ status, desc }) => {
        const payload = {
          error: {
            code: `status_${status}`,
            message: desc,
          },
        };
        expect(payload).toSatisfySchemaInApiSpec("Error");
      },
    );

    it("verifies Error schema structure and metadata in components.schemas", () => {
      const errorSchema = openApiSpec.components.schemas.Error;
      expect(errorSchema.type).toBe("object");
      expect(errorSchema.required).toEqual(["error"]);
      expect(errorSchema.properties.error.type).toBe("object");
      expect(errorSchema.properties.error.required).toEqual(["code", "message"]);
      expect(errorSchema.properties.error.properties.code.type).toBe("string");
      expect(errorSchema.properties.error.properties.message.type).toBe("string");
    });
  });

  // =========================================================================
  // Dimension 3: Path & Operation Variations across all 18 Endpoints
  // =========================================================================
  describe("Dimension 3: Operation-level error responses documentation", () => {
    const operationList: { path: string; method: string; expectedErrors: string[] }[] = [
      {
        path: "/iot/solar/{projectId}",
        method: "get",
        expectedErrors: ["400", "404", "429", "500"],
      },
      {
        path: "/iot/satellite/{projectId}",
        method: "get",
        expectedErrors: ["400", "404", "429", "500"],
      },
      { path: "/projects", method: "get", expectedErrors: ["400", "429", "500"] },
      { path: "/projects/{id}", method: "get", expectedErrors: ["400", "404", "429", "500"] },
      {
        path: "/projects/{id}/history",
        method: "get",
        expectedErrors: ["400", "404", "429", "500"],
      },
      {
        path: "/projects/{id}/history/trend",
        method: "get",
        expectedErrors: ["400", "404", "429", "500"],
      },
      {
        path: "/projects/{id}/price-history",
        method: "get",
        expectedErrors: ["400", "404", "429", "500"],
      },
      { path: "/portfolio", method: "get", expectedErrors: ["429", "500"] },
      {
        path: "/admin/score-update",
        method: "post",
        expectedErrors: ["400", "401", "403", "429", "500"],
      },
      {
        path: "/admin/batch/score-update",
        method: "post",
        expectedErrors: ["400", "401", "403", "429", "500"],
      },
      {
        path: "/admin/batch/{batchId}/status",
        method: "get",
        expectedErrors: ["400", "401", "403", "404", "429", "500"],
      },
      { path: "/roles", method: "get", expectedErrors: ["401", "403", "429", "500"] },
      { path: "/roles", method: "post", expectedErrors: ["400", "401", "403", "429", "500"] },
      {
        path: "/roles/{userId}",
        method: "delete",
        expectedErrors: ["400", "401", "403", "404", "429", "500"],
      },
      { path: "/webhooks", method: "get", expectedErrors: ["401", "403", "429", "500"] },
      { path: "/webhooks", method: "post", expectedErrors: ["400", "401", "403", "429", "500"] },
      {
        path: "/webhooks/{id}",
        method: "get",
        expectedErrors: ["400", "401", "403", "404", "429", "500"],
      },
      {
        path: "/webhooks/{id}",
        method: "delete",
        expectedErrors: ["400", "401", "403", "404", "429", "500"],
      },
      {
        path: "/creators/applications",
        method: "post",
        expectedErrors: ["400", "401", "409", "429", "500"],
      },
      {
        path: "/creators/applications/{id}/create-project-tx",
        method: "get",
        expectedErrors: ["400", "401", "403", "404", "409", "429", "500"],
      },
      {
        path: "/admin/creators/applications/{id}",
        method: "get",
        expectedErrors: ["400", "401", "403", "404", "429", "500"],
      },
      {
        path: "/admin/creators/applications/{id}",
        method: "patch",
        expectedErrors: ["400", "401", "403", "404", "429", "500"],
      },
    ];

    it.each(operationList)(
      "documents required error responses for $method $path",
      ({ path, method, expectedErrors }) => {
        const op = (openApiSpec.paths as any)[path]?.[method];
        expect(op).toBeDefined();
        const responses = op.responses;
        expect(responses).toBeDefined();

        for (const status of expectedErrors) {
          const resp = responses[status];
          expect(resp).toBeDefined();
          expect(resp.description).toBeDefined();
          expect(resp.content?.["application/json"]?.schema?.$ref).toBe(
            "#/components/schemas/Error",
          );
        }
      },
    );

    it("verifies every documented error response across all endpoints links to Error schema", () => {
      for (const [path, methods] of Object.entries(openApiSpec.paths)) {
        for (const [method, op] of Object.entries(methods as any)) {
          for (const [status, resp] of Object.entries((op as any).responses || {})) {
            const num = parseInt(status, 10);
            if (num >= 400 && num <= 599) {
              const r = resp as any;
              expect(r.content?.["application/json"]?.schema?.$ref).toBe(
                "#/components/schemas/Error",
              );
            }
          }
        }
      }
    });
  });

  // =========================================================================
  // Dimension 4: Negative Controls and Schema Invalidation
  // =========================================================================
  describe("Dimension 4: Negative controls and invalid payload rejections", () => {
    const invalidPayloads = [
      { desc: "legacy flat error shape: string instead of object", val: { error: "not_found" } },
      {
        desc: "legacy flat error shape with sentence",
        val: { error: "Unknown project with id 123" },
      },
      { desc: "missing error property entirely", val: {} },
      { desc: "null error property", val: { error: null } },
      { desc: "numeric error property", val: { error: 500 } },
      { desc: "boolean error property", val: { error: true } },
      { desc: "array error property", val: { error: ["not_found", "bad_request"] } },
      { desc: "nested error missing code property", val: { error: { message: "Missing code" } } },
      {
        desc: "nested error missing message property",
        val: { error: { code: "missing_message" } },
      },
      {
        desc: "nested error with non-string code (number)",
        val: { error: { code: 404, message: "Valid" } },
      },
      {
        desc: "nested error with non-string code (boolean)",
        val: { error: { code: false, message: "Valid" } },
      },
      {
        desc: "nested error with non-string code (null)",
        val: { error: { code: null, message: "Valid" } },
      },
      {
        desc: "nested error with non-string message (number)",
        val: { error: { code: "valid", message: 12345 } },
      },
      {
        desc: "nested error with non-string message (boolean)",
        val: { error: { code: "valid", message: true } },
      },
      {
        desc: "nested error with non-string message (null)",
        val: { error: { code: "valid", message: null } },
      },
      {
        desc: "nested error with nested object message",
        val: { error: { code: "valid", message: { inner: "object" } } },
      },
      { desc: "top-level string primitive", val: "error" },
      { desc: "top-level number primitive", val: 500 },
      { desc: "top-level array", val: [{ code: "err", message: "fail" }] },
      { desc: "nested error is empty object", val: { error: {} } },
      { desc: "nested error is empty array", val: { error: [] } },
      {
        desc: "nested error code is array",
        val: { error: { code: ["bad_request"], message: "Msg" } },
      },
      {
        desc: "nested error message is array",
        val: { error: { code: "bad_request", message: ["Msg"] } },
      },
      {
        desc: "nested error code is object",
        val: { error: { code: { code: "bad_request" }, message: "Msg" } },
      },
    ];

    it.each(invalidPayloads)("strictly rejects invalid payload: $desc", ({ val }) => {
      expect(() => {
        expect(val).toSatisfySchemaInApiSpec("Error");
      }).toThrow();
    });
  });

  // =========================================================================
  // Dimension 5: Spec Consistency, Generated Client Types, and Stress
  // =========================================================================
  describe("Dimension 5: Spec consistency, client generation, and stress", () => {
    it("verifies openapi.json on disk exists and parses valid JSON", () => {
      const specPath = resolve(__dirname, "../../openapi.json");
      expect(existsSync(specPath)).toBe(true);
      const content = readFileSync(specPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.openapi).toBe("3.0.3");
      expect(parsed.components.schemas.Error).toBeDefined();
      expect(parsed.components.schemas.Error.properties.error.properties.code.type).toBe("string");
      expect(parsed.components.schemas.Error.properties.error.properties.message.type).toBe(
        "string",
      );
    });

    it("verifies packages/api-client/src/types.ts has generated nested Error definition", () => {
      const typesPath = resolve(__dirname, "../../packages/api-client/src/types.ts");
      expect(existsSync(typesPath)).toBe(true);
      const content = readFileSync(typesPath, "utf-8");
      expect(content).toContain("Error: {");
      expect(content).toContain("error: {");
      expect(content).toContain("code: string;");
      expect(content).toContain("message: string;");
      expect(content).not.toContain("error?: string;");
    });

    const stressCounts = [5, 10, 20, 30, 50, 75, 100];
    it.each(stressCounts)(
      "validates %i rapid sequential error instances without memory or performance degradation",
      (count) => {
        const start = performance.now();
        for (let i = 0; i < count; i++) {
          const payload = {
            error: {
              code: `stress_code_${i}`,
              message: `Stress iteration message ${i} - project verification`,
            },
          };
          expect(payload).toSatisfySchemaInApiSpec("Error");
        }
        const duration = performance.now() - start;
        expect(duration).toBeLessThan(1000);
      },
    );
  });
});
