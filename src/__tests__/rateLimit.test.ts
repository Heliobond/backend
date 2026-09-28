import request from "supertest";
import express, { Express } from "express";
import { createRateLimiter, parseTrustProxy } from "../middleware/rateLimit";

function buildApp(max: number): Express {
  const app = express();
  app.use(createRateLimiter(60_000, max));
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("rate limiting", () => {
  describe("parseTrustProxy", () => {
    it("returns false for undefined, empty, or 'false'", () => {
      expect(parseTrustProxy(undefined)).toBe(false);
      expect(parseTrustProxy("")).toBe(false);
      expect(parseTrustProxy("false")).toBe(false);
    });

    it("returns true for 'true'", () => {
      expect(parseTrustProxy("true")).toBe(true);
    });

    it("returns number for numeric hop counts", () => {
      expect(parseTrustProxy("1")).toBe(1);
      expect(parseTrustProxy("2")).toBe(2);
    });

    it("returns string as-is for CIDR or subnet strings", () => {
      expect(parseTrustProxy("loopback")).toBe("loopback");
      expect(parseTrustProxy("10.0.0.0/8")).toBe("10.0.0.0/8");
    });
  });

  it("allows requests under the limit", async () => {
    const app = buildApp(2);
    await request(app).get("/ping").expect(200);
    await request(app).get("/ping").expect(200);
  });

  it("returns 429 with Retry-After and a structured body once the limit is exceeded", async () => {
    const app = buildApp(1);
    await request(app).get("/ping").expect(200);

    const res = await request(app).get("/ping").expect(429);
    expect(res.body).toEqual({
      error: {
        code: "too_many_requests",
        message: expect.stringContaining("Rate limit"),
      },
    });
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("advertises RateLimit standard headers", async () => {
    const app = buildApp(5);
    const res = await request(app).get("/ping").expect(200);
    expect(res.headers).toHaveProperty("ratelimit-limit");
  });

  it("isolates rate-limit buckets per client IP when trust proxy is enabled", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(createRateLimiter(60_000, 1));
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    // Client 1 sends request and hits the limit
    await request(app).get("/ping").set("X-Forwarded-For", "203.0.113.1").expect(200);

    // Client 1 is now rate-limited
    await request(app).get("/ping").set("X-Forwarded-For", "203.0.113.1").expect(429);

    // Client 2 with a different IP should NOT be affected by Client 1
    const resClient2 = await request(app)
      .get("/ping")
      .set("X-Forwarded-For", "203.0.113.2")
      .expect(200);

    expect(resClient2.body).toEqual({ ok: true });
  });
});
