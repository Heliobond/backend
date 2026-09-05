import request from "supertest";
import express, { Express } from "express";
import { createRateLimiter } from "../middleware/rateLimit";

function buildApp(max: number, windowMs: number = 60_000): Express {
  const app = express();
  app.use(createRateLimiter(windowMs, max));
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("rate limiting scenarios", () => {
  it("10 requests within limit → all succeed", async () => {
    const app = buildApp(10);
    for (let i = 0; i < 10; i++) {
      await request(app).get("/ping").expect(200);
    }
  });

  it("11th request → 429", async () => {
    const app = buildApp(10);
    for (let i = 0; i < 10; i++) {
      await request(app).get("/ping").expect(200);
    }
    const res = await request(app).get("/ping").expect(429);
    expect(res.body).toEqual({
      error: {
        code: "too_many_requests",
        message: expect.stringContaining("Rate limit"),
      },
    });
  });

  it("429 response includes Retry-After header", async () => {
    const app = buildApp(1);
    await request(app).get("/ping").expect(200);
    const res = await request(app).get("/ping").expect(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number.isFinite(Number(res.headers["retry-after"]))).toBe(true);
  });

  it("after window reset → requests succeed again", async () => {
    const app = buildApp(1, 200);
    await request(app).get("/ping").expect(200);
    await request(app).get("/ping").expect(429);

    await new Promise((r) => setTimeout(r, 250));

    const res = await request(app).get("/ping").expect(200);
    expect(res.body).toEqual({ ok: true });
  });
});
