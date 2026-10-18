import request from "supertest";
import express from "express";
import swaggerUi from "swagger-ui-express";
import {
  securityHeaders,
  permissionsHeaders,
  DEFAULT_CSP_DIRECTIVES,
  DOCS_CSP_DIRECTIVES,
} from "../middleware/securityHeaders";
import { openApiSpec } from "../lib/swagger";

describe("securityHeaders middleware and Content-Security-Policy enforcement", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(securityHeaders);
    app.use(permissionsHeaders);
    app.get("/test", (_req, res) => res.json({ ok: true }));
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));
    app.get("/docs.json", (_req, res) => res.json(openApiSpec));
  });

  // =========================================================================
  // Baseline Core Contracts (Original Regression Suite)
  // =========================================================================
  describe("Core security header standards", () => {
    it("sets X-Content-Type-Options: nosniff", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("sets X-Frame-Options: DENY", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    });

    it("sets X-XSS-Protection header", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["x-xss-protection"]).toBeDefined();
      expect(res.headers["x-xss-protection"]).toBe("0");
    });

    it("sets Strict-Transport-Security with max-age", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["strict-transport-security"]).toBeDefined();
      expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
      expect(res.headers["strict-transport-security"]).toContain("includeSubDomains");
      expect(res.headers["strict-transport-security"]).toContain("preload");
    });

    it("applies security headers to all response types", async () => {
      app.get("/json", (_req, res) => res.json({ data: "test" }));
      app.get("/text", (_req, res) => res.send("test"));
      app.post("/post", (_req, res) => res.status(201).json({ created: true }));

      const jsonRes = await request(app).get("/json");
      expect(jsonRes.headers["x-content-type-options"]).toBe("nosniff");
      expect(jsonRes.headers["x-frame-options"]).toBe("DENY");

      const textRes = await request(app).get("/text");
      expect(textRes.headers["x-content-type-options"]).toBe("nosniff");
      expect(textRes.headers["x-frame-options"]).toBe("DENY");

      const postRes = await request(app).post("/post");
      expect(postRes.headers["x-content-type-options"]).toBe("nosniff");
      expect(postRes.headers["x-frame-options"]).toBe("DENY");
    });

    it("sets all expected security headers on every request", async () => {
      const res = await request(app).get("/test");

      const expectedHeaders = [
        "x-content-type-options",
        "x-frame-options",
        "strict-transport-security",
        "x-xss-protection",
        "referrer-policy",
        "content-security-policy",
        "permissions-policy",
      ];

      expectedHeaders.forEach((header) => {
        expect(res.headers[header]).toBeDefined();
      });
    });

    it("sets Content-Security-Policy header on non-docs route", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["content-security-policy"]).toBeDefined();
      expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    });

    it("sets Referrer-Policy header", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    });

    it("sets Permissions-Policy header", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["permissions-policy"]).toBeDefined();
      expect(res.headers["permissions-policy"]).toContain("camera=()");
      expect(res.headers["permissions-policy"]).toContain("microphone=()");
      expect(res.headers["permissions-policy"]).toContain("geolocation=()");
    });
  });

  // =========================================================================
  // Section 1: Docs-Scoped Content-Security-Policy Enforcement (Issue #924)
  // =========================================================================
  describe("Docs-scoped Content-Security-Policy enforcement", () => {
    it("ensures /docs responses carry a Content-Security-Policy header rather than disabling it", async () => {
      const res = await request(app).get("/docs/");
      expect(res.headers["content-security-policy"]).toBeDefined();
      expect(res.headers["content-security-policy"]).not.toBe("");
    });

    it("allows inline scripts and styles on /docs for Swagger UI initialization", async () => {
      const res = await request(app).get("/docs/");
      const csp = res.headers["content-security-policy"];
      expect(csp).toContain("script-src 'self' 'unsafe-inline' https://unpkg.com");
      expect(csp).toContain("style-src 'self' 'unsafe-inline' https://unpkg.com");
    });

    it("permits Swagger validator image origin and data URLs on /docs", async () => {
      const res = await request(app).get("/docs/");
      const csp = res.headers["content-security-policy"];
      expect(csp).toContain("img-src 'self' data: https://validator.swagger.io");
    });

    it("enforces strict containment on object-src and frame-ancestors for /docs", async () => {
      const res = await request(app).get("/docs/");
      const csp = res.headers["content-security-policy"];
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
    });

    it("disallows unsafe-inline scripts on standard application routes", async () => {
      const res = await request(app).get("/test");
      const csp = res.headers["content-security-policy"];
      expect(csp).toContain("script-src 'self' https://unpkg.com");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    });
  });

  // =========================================================================
  // Section 2: Path Variations and Route Matching Matrix
  // =========================================================================
  describe("Path variations and prefix matching verification", () => {
    const docsPathVariants = [
      "/docs/",
      "/docs/index.html",
      "/docs/swagger-ui.css",
      "/docs/swagger-ui-bundle.js",
      "/docs/swagger-ui-standalone-preset.js",
      "/docs/favicon-32x32.png",
      "/docs/oauth2-redirect.html",
      "/docs/v1",
      "/docs/spec",
      "/docs/assets/bundle.js",
      "/docs/?url=/v1/spec",
      "/docs/?theme=dark",
      "/docs/subpath/endpoint",
      "/docs/static/styles.css",
    ];

    it.each(docsPathVariants)(
      "consistently attaches docs-compatible CSP header for docs route variant %s",
      async (path) => {
        const res = await request(app).get(path);
        const csp = res.headers["content-security-policy"];
        expect(csp).toBeDefined();
        expect(csp).toContain("script-src 'self' 'unsafe-inline' https://unpkg.com");
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
      },
    );

    it("redirects bare /docs to /docs/ while maintaining an active Content-Security-Policy header", async () => {
      const res = await request(app).get("/docs");
      expect(res.status).toBe(301);
      expect(res.headers["content-security-policy"]).toBeDefined();
    });

    it("redirects bare /docs with query params while maintaining an active Content-Security-Policy header", async () => {
      const res = await request(app).get("/docs?url=/v1/spec");
      expect(res.status).toBe(301);
      expect(res.headers["content-security-policy"]).toBeDefined();
    });

    const nonDocsPathVariants = [
      "/test",
      "/api",
      "/api/v1",
      "/v1/projects",
      "/v1/scores",
      "/v1/admin",
      "/health",
      "/metrics",
      "/status",
      "/documentation",
      "/my-docs",
      "/public/docs",
      "/api/docs",
      "/v1/docs",
      "/docs.json",
    ];

    it.each(nonDocsPathVariants)(
      "enforces strict default CSP without unsafe-inline script on route %s",
      async (path) => {
        app.get(path.split("?")[0], (_req, res) => res.json({ route: path }));
        const res = await request(app).get(path);
        const csp = res.headers["content-security-policy"];
        expect(csp).toBeDefined();
        expect(csp).toContain("default-src 'self'");
        expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
      },
    );
  });

  // =========================================================================
  // Section 3: HTTP Method Variations on /docs and Regular Routes
  // =========================================================================
  describe("HTTP method variations across endpoints", () => {
    const httpMethods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;

    it.each(httpMethods)(
      "enforces docs CSP on %s /docs/ regardless of request method",
      async (method) => {
        const res = await (request(app)[method]("/docs/") as any);
        expect(res.headers["content-security-policy"]).toBeDefined();
        expect(res.headers["content-security-policy"]).toContain("'unsafe-inline'");
        expect(res.headers["content-security-policy"]).toContain("object-src 'none'");
      },
    );

    it.each(httpMethods)(
      "enforces standard strict CSP on %s /test regardless of request method",
      async (method) => {
        app[method]("/test-method", (_req: express.Request, res: express.Response) =>
          res.send("ok"),
        );
        const res = await (request(app)[method]("/test-method") as any);
        expect(res.headers["content-security-policy"]).toBeDefined();
        expect(res.headers["content-security-policy"]).not.toContain(
          "script-src 'self' 'unsafe-inline'",
        );
      },
    );
  });

  // =========================================================================
  // Section 4: Status Code Independence and Error Boundary Headers
  // =========================================================================
  describe("Security headers preservation across HTTP status codes", () => {
    const statusCodes = [200, 201, 204, 301, 400, 401, 403, 404, 429, 500];

    it.each(statusCodes)(
      "preserves security headers when /docs endpoint responds with status %i",
      async (code) => {
        const testApp = express();
        testApp.use(securityHeaders);
        testApp.use(permissionsHeaders);
        testApp.get("/docs/test-status", (_req, res) => {
          if (code === 204) return res.status(204).end();
          return res.status(code).json({ code });
        });

        const res = await request(testApp).get("/docs/test-status");
        expect(res.status).toBe(code);
        expect(res.headers["content-security-policy"]).toBeDefined();
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["x-frame-options"]).toBe("DENY");
        expect(res.headers["strict-transport-security"]).toBeDefined();
      },
    );

    it.each(statusCodes)(
      "preserves standard strict CSP when API responds with status %i",
      async (code) => {
        const customPath = `/api/status-${code}`;
        app.get(customPath, (_req, res) => {
          if (code === 204) return res.status(204).end();
          return res.status(code).json({ code });
        });

        const res = await request(app).get(customPath);
        expect(res.status).toBe(code);
        expect(res.headers["content-security-policy"]).toBeDefined();
        expect(res.headers["content-security-policy"]).not.toContain(
          "script-src 'self' 'unsafe-inline'",
        );
      },
    );
  });

  // =========================================================================
  // Section 5: Directive Constants and Stress Request Stability
  // =========================================================================
  describe("Directives schema contract and rapid sequential executions", () => {
    it("exports DEFAULT_CSP_DIRECTIVES with exact policy configuration", () => {
      expect(DEFAULT_CSP_DIRECTIVES.defaultSrc).toEqual(["'self'"]);
      expect(DEFAULT_CSP_DIRECTIVES.scriptSrc).toEqual(["'self'", "https://unpkg.com"]);
      expect(DEFAULT_CSP_DIRECTIVES.objectSrc).toEqual(["'none'"]);
      expect(DEFAULT_CSP_DIRECTIVES.frameAncestors).toEqual(["'none'"]);
    });

    it("exports DOCS_CSP_DIRECTIVES with exact scoped permissions", () => {
      expect(DOCS_CSP_DIRECTIVES.defaultSrc).toEqual(["'self'"]);
      expect(DOCS_CSP_DIRECTIVES.scriptSrc).toEqual([
        "'self'",
        "'unsafe-inline'",
        "https://unpkg.com",
      ]);
      expect(DOCS_CSP_DIRECTIVES.imgSrc).toEqual([
        "'self'",
        "data:",
        "https://validator.swagger.io",
      ]);
      expect(DOCS_CSP_DIRECTIVES.objectSrc).toEqual(["'none'"]);
      expect(DOCS_CSP_DIRECTIVES.frameAncestors).toEqual(["'none'"]);
    });

    const individualDirectives = [
      ["default-src", "'self'"],
      ["object-src", "'none'"],
      ["frame-ancestors", "'none'"],
      ["base-uri", "'self'"],
      ["form-action", "'self'"],
    ] as const;

    it.each(individualDirectives)(
      "verifies common restrictive directive %s contains %s on /docs",
      async (directive, token) => {
        const res = await request(app).get("/docs/");
        const csp = res.headers["content-security-policy"];
        expect(csp).toContain(`${directive} ${token}`);
      },
    );

    it.each(individualDirectives)(
      "verifies common restrictive directive %s contains %s on /test",
      async (directive, token) => {
        const res = await request(app).get("/test");
        const csp = res.headers["content-security-policy"];
        expect(csp).toContain(`${directive} ${token}`);
      },
    );

    const burstCounts = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100];
    it.each(burstCounts)(
      "retains consistent CSP header across burst of %i rapid sequential calls to /docs/",
      async (count) => {
        for (let i = 0; i < count; i++) {
          const res = await request(app).get("/docs/");
          expect(res.headers["content-security-policy"]).toBeDefined();
          expect(res.headers["content-security-policy"]).toContain(
            "script-src 'self' 'unsafe-inline'",
          );
        }
      },
    );

    it("serves Swagger UI html with active CSP header and expected layout markup", async () => {
      const res = await request(app).get("/docs/");
      expect(res.status).toBe(200);
      expect(res.text).toContain("swagger-ui");
      expect(res.text).toContain("swagger-ui-bundle.js");
      expect(res.headers["content-security-policy"]).toBeDefined();
    });
  });
});
