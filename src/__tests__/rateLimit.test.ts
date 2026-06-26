import request from "supertest";
import express, { Express } from "express";
import { createRateLimiter } from "../middleware/rateLimit";

function buildApp(max: number): Express {
  const app = express();
  app.use(createRateLimiter(60_000, max));
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("rate limiting", () => {
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
      error: "too_many_requests",
      message: expect.stringContaining("Rate limit"),
    });
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("advertises RateLimit standard headers", async () => {
    const app = buildApp(5);
    const res = await request(app).get("/ping").expect(200);
    expect(res.headers).toHaveProperty("ratelimit-limit");
  });
});
