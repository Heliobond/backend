import express from "express";
import request from "supertest";
import { ipWhitelist, refreshIPWhitelist } from "../middleware/ipWhitelist";

describe("IP Whitelist Middleware", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    originalEnv = { ...process.env };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  afterEach(() => {
    delete process.env.ADMIN_IP_WHITELIST;
    delete process.env.ADMIN_IP_WHITELIST_BYPASS_PRIVATE;
    refreshIPWhitelist();
  });

  // ── Tests without trust proxy (default — no reverse proxy) ──────────────
  describe("without trust proxy (default)", () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      // No app.set("trust proxy") — default Express behavior.
      // req.ip is the direct socket peer address; X-Forwarded-For is ignored.
      app.use(ipWhitelist);
      app.get("/test", (_req, res) => res.json({ success: true }));
    });

    it("should allow all requests when whitelist is empty", async () => {
      delete process.env.ADMIN_IP_WHITELIST;
      refreshIPWhitelist();

      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should block requests from non-whitelisted IPs", async () => {
      process.env.ADMIN_IP_WHITELIST = "203.0.113.1";
      process.env.ADMIN_IP_WHITELIST_BYPASS_PRIVATE = "false";
      refreshIPWhitelist();

      // supertest connects from 127.0.0.1; whitelist is 203.0.113.1 → blocked
      const res = await request(app).get("/test");
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    it("should ignore spoofed X-Forwarded-For and use socket address", async () => {
      process.env.ADMIN_IP_WHITELIST = "203.0.113.1";
      process.env.ADMIN_IP_WHITELIST_BYPASS_PRIVATE = "false";
      refreshIPWhitelist();

      // Attacker spoofs X-Forwarded-For to match the whitelist, but without
      // trust proxy Express uses the real socket address (127.0.0.1).
      const res = await request(app)
        .get("/test")
        .set("X-Forwarded-For", "203.0.113.1");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    it("should ignore spoofed X-Real-IP", async () => {
      process.env.ADMIN_IP_WHITELIST = "203.0.113.1";
      process.env.ADMIN_IP_WHITELIST_BYPASS_PRIVATE = "false";
      refreshIPWhitelist();

      const res = await request(app)
        .get("/test")
        .set("X-Real-IP", "203.0.113.1");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    it("should block spoofed private IP bypass via X-Forwarded-For", async () => {
      process.env.ADMIN_IP_WHITELIST = "1.2.3.4";
      refreshIPWhitelist(); // bypassPrivateNetworks defaults to true

      // Attacker tries to bypass whitelist by spoofing a private IP.
      // Without trust proxy, the real socket IP (127.0.0.1) IS the peer
      // address, so the private bypass kicks in — which is correct: local
      // requests from loopback should be allowed.
      const res = await request(app)
        .get("/test")
        .set("X-Forwarded-For", "192.168.1.100");

      // 127.0.0.1 is the real socket peer → isPrivateIP(127.0.0.1) = true → bypass
      expect(res.status).toBe(200);
    });

    it("should support CIDR notation", async () => {
      process.env.ADMIN_IP_WHITELIST = "127.0.0.0/8";
      refreshIPWhitelist();

      // supertest connects from 127.0.0.1 which falls within 127.0.0.0/8
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    });

    it("should support multiple CIDR ranges", async () => {
      process.env.ADMIN_IP_WHITELIST = "127.0.0.0/8,203.0.113.0/24";
      refreshIPWhitelist();

      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    });

    it("should handle IPv4-mapped IPv6 addresses", async () => {
      process.env.ADMIN_IP_WHITELIST = "127.0.0.1";
      refreshIPWhitelist();

      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    });
  });

  // ── Tests with trust proxy configured ───────────────────────────────────
  describe("with trust proxy configured", () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.set("trust proxy", true);
      app.use(ipWhitelist);
      app.get("/test", (_req, res) => res.json({ success: true }));
    });

    it("should allow requests from whitelisted IPs via X-Forwarded-For", async () => {
      process.env.ADMIN_IP_WHITELIST = "10.0.0.1";
      refreshIPWhitelist();

      const res = await request(app)
        .get("/test")
        .set("X-Forwarded-For", "10.0.0.1");

      expect(res.status).toBe(200);
    });

    it("should support CIDR notation via X-Forwarded-For", async () => {
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

    it("should block non-whitelisted IPs via X-Forwarded-For", async () => {
      process.env.ADMIN_IP_WHITELIST = "10.0.0.1";
      process.env.ADMIN_IP_WHITELIST_BYPASS_PRIVATE = "false";
      refreshIPWhitelist();

      const res = await request(app)
        .get("/test")
        .set("X-Forwarded-For", "8.8.8.8");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    it("should bypass private networks by default", async () => {
      process.env.ADMIN_IP_WHITELIST = "1.2.3.4";
      refreshIPWhitelist();

      const res = await request(app)
        .get("/test")
        .set("X-Forwarded-For", "192.168.1.100");

      expect(res.status).toBe(200);
    });

    it("should not bypass private networks when configured off", async () => {
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
  });
});
