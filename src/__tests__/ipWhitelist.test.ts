import express from "express";
import request from "supertest";
import { ipWhitelist, refreshIPWhitelist } from "../middleware/ipWhitelist";

describe("IP Whitelist Middleware", () => {
  let app: express.Express;
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    originalEnv = { ...process.env };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    app = express();
    app.set("trust proxy", true);
    app.use(ipWhitelist);
    app.get("/test", (_req, res) => res.json({ success: true }));
  });

  afterEach(() => {
    delete process.env.ADMIN_IP_WHITELIST;
    delete process.env.ADMIN_IP_WHITELIST_BYPASS_PRIVATE;
    refreshIPWhitelist();
  });

  it("should allow all requests when whitelist is empty", async () => {
    delete process.env.ADMIN_IP_WHITELIST;
    refreshIPWhitelist();

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should block requests from non-whitelisted public IPs", async () => {
    process.env.ADMIN_IP_WHITELIST = "192.168.1.100";
    process.env.ADMIN_IP_WHITELIST_BYPASS_PRIVATE = "false";
    refreshIPWhitelist();

    const res = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "8.8.8.8");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("should allow requests from whitelisted IPs", async () => {
    process.env.ADMIN_IP_WHITELIST = "10.0.0.1";
    refreshIPWhitelist();

    const res = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "10.0.0.1");

    expect(res.status).toBe(200);
  });

  it("should support CIDR notation", async () => {
    process.env.ADMIN_IP_WHITELIST = "10.0.0.0/24";
    refreshIPWhitelist();

    const res = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "10.0.0.50");

    expect(res.status).toBe(200);
  });

  it("should block public IPs outside CIDR range", async () => {
    process.env.ADMIN_IP_WHITELIST = "10.0.0.0/24";
    process.env.ADMIN_IP_WHITELIST_BYPASS_PRIVATE = "false";
    refreshIPWhitelist();

    const res = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "203.0.113.5");

    expect(res.status).toBe(403);
  });

  it("should support multiple CIDR ranges", async () => {
    process.env.ADMIN_IP_WHITELIST = "10.0.0.0/24,203.0.113.0/24";
    refreshIPWhitelist();

    const res1 = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "10.0.0.50");
    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "203.0.113.50");
    expect(res2.status).toBe(200);
  });

  it("should bypass private networks by default", async () => {
    process.env.ADMIN_IP_WHITELIST = "1.2.3.4";
    refreshIPWhitelist();

    const res = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "192.168.1.100");

    expect(res.status).toBe(200);
  });

  it("should not bypass private networks when configured", async () => {
    process.env.ADMIN_IP_WHITELIST = "1.2.3.4";
    process.env.ADMIN_IP_WHITELIST_BYPASS_PRIVATE = "false";
    refreshIPWhitelist();

    const res = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "192.168.1.100");

    expect(res.status).toBe(403);
  });

  it("should handle IPv4-mapped IPv6 addresses", async () => {
    process.env.ADMIN_IP_WHITELIST = "10.0.0.1";
    refreshIPWhitelist();

    const res = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "::ffff:10.0.0.1");

    expect(res.status).toBe(200);
  });
});
