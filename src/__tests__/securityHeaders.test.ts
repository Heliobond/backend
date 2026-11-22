import request from "supertest";
import express from "express";
import { securityHeaders, permissionsHeaders } from "../middleware/securityHeaders";

describe("securityHeaders middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(securityHeaders);
    app.use(permissionsHeaders);
    app.get("/test", (_req, res) => res.json({ ok: true }));
  });

  describe("Helmet Security Headers (Issue #269, #288)", () => {
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
  });

  it("sets Content-Security-Policy header", async () => {
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
