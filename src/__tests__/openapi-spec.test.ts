import { openApiSpec } from "../lib/swagger";

describe("OpenAPI spec validity (#281)", () => {
  describe("OpenAPI 3.0 structure", () => {
    it("declares openapi version 3.x", () => {
      expect(openApiSpec.openapi).toMatch(/^3\.\d+\.\d+$/);
    });

    it("has required info block with title and version", () => {
      expect(openApiSpec.info).toBeDefined();
      expect(typeof openApiSpec.info.title).toBe("string");
      expect(openApiSpec.info.title.length).toBeGreaterThan(0);
      expect(typeof openApiSpec.info.version).toBe("string");
      expect(openApiSpec.info.version.length).toBeGreaterThan(0);
    });

    it("has at least one server entry", () => {
      expect(Array.isArray(openApiSpec.servers)).toBe(true);
      expect(openApiSpec.servers!.length).toBeGreaterThan(0);
      openApiSpec.servers!.forEach((server) => {
        expect(typeof server.url).toBe("string");
      });
    });

    it("has a paths object", () => {
      expect(openApiSpec.paths).toBeDefined();
      expect(typeof openApiSpec.paths).toBe("object");
    });

    it("has a components block with schemas", () => {
      expect(openApiSpec.components).toBeDefined();
      expect(openApiSpec.components!.schemas).toBeDefined();
    });
  });

  describe("core endpoints are documented", () => {
    const paths = Object.keys(openApiSpec.paths);

    it("documents IoT solar endpoint", () => {
      const match = paths.find((p) => p.includes("solar"));
      expect(match).toBeDefined();
    });

    it("documents IoT satellite endpoint", () => {
      const match = paths.find((p) => p.includes("satellite"));
      expect(match).toBeDefined();
    });

    it("documents projects list endpoint", () => {
      expect(paths).toContain("/projects");
    });

    it("documents individual project endpoint", () => {
      const match = paths.find(
        (p) => p.includes("projects") && p.includes("{id}") && !p.includes("history"),
      );
      expect(match).toBeDefined();
    });

    it("documents score history endpoint", () => {
      const match = paths.find((p) => p.includes("history"));
      expect(match).toBeDefined();
    });

    it("documents admin score-update endpoint", () => {
      const match = paths.find((p) => p.includes("admin") && p.includes("score"));
      expect(match).toBeDefined();
    });

    it("documents roles endpoint", () => {
      const match = paths.find((p) => p.includes("roles"));
      expect(match).toBeDefined();
    });

    it("documents webhooks endpoint", () => {
      const match = paths.find((p) => p.includes("webhooks"));
      expect(match).toBeDefined();
    });
  });

  describe("each path entry is well-formed", () => {
    const entries = Object.entries(openApiSpec.paths) as [string, Record<string, any>][];

    it("each path starts with /", () => {
      entries.forEach(([path]) => {
        expect(path.startsWith("/")).toBe(true);
      });
    });

    it("each operation has a summary", () => {
      entries.forEach(([path, methods]) => {
        Object.entries(methods).forEach(([method, op]: [string, any]) => {
          expect(op.summary).toBeDefined();
          expect(typeof op.summary).toBe("string");
        });
      });
    });

    it("each operation has at least one response defined", () => {
      entries.forEach(([path, methods]) => {
        Object.entries(methods).forEach(([method, op]: [string, any]) => {
          expect(op.responses).toBeDefined();
          expect(Object.keys(op.responses).length).toBeGreaterThan(0);
        });
      });
    });
  });

  describe("components/schemas", () => {
    const schemas = openApiSpec.components?.schemas ?? {};

    it("defines Error schema", () => {
      expect(schemas.Error).toBeDefined();
      expect(schemas.Error.properties.error.type).toBe("object");
      expect(schemas.Error.properties.error.properties.code.type).toBe("string");
      expect(schemas.Error.properties.error.properties.message.type).toBe("string");
    });

    it("documents common error responses", () => {
      const projectGet = openApiSpec.paths["/projects/{id}"].get.responses;
      expect(Object.keys(projectGet)).toEqual(expect.arrayContaining(["400", "404", "429", "500"]));
    });

    it("defines Project schema", () => {
      expect(schemas.Project).toBeDefined();
    });

    it("defines BatchJob schema", () => {
      expect(schemas.BatchJob).toBeDefined();
    });

    it("defines Role schema", () => {
      expect(schemas.Role).toBeDefined();
    });

    it("each schema has a type or $ref", () => {
      Object.entries(schemas).forEach(([name, schema]: [string, any]) => {
        const hasType = schema.type !== undefined;
        const hasRef = schema.$ref !== undefined;
        expect(hasType || hasRef).toBe(true);
      });
    });
  });

  describe("auth requirements documented", () => {
    it("defines a securityScheme", () => {
      expect(openApiSpec.components?.securitySchemes).toBeDefined();
      expect(Object.keys(openApiSpec.components!.securitySchemes!).length).toBeGreaterThan(0);
    });

    it("admin endpoints reference a security scheme", () => {
      const paths = openApiSpec.paths as Record<string, Record<string, any>>;
      const adminOps = Object.entries(paths)
        .filter(([p]) => p.includes("admin"))
        .flatMap(([, methods]) => Object.values(methods));

      adminOps.forEach((op: any) => {
        expect(op.security).toBeDefined();
        expect(Array.isArray(op.security)).toBe(true);
      });
    });
  });
});
