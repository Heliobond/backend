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

  it("sets Content-Security-Policy header", async () => {
    const res = await request(app).get("/test");
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("sets X-Content-Type-Options header", async () => {
    const res = await request(app).get("/test");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options header", async () => {
    const res = await request(app).get("/test");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("sets Strict-Transport-Security header", async () => {
    const res = await request(app).get("/test");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
  });

  it("sets X-XSS-Protection header", async () => {
    const res = await request(app).get("/test");
    expect(res.headers["x-xss-protection"]).toBeDefined();
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
