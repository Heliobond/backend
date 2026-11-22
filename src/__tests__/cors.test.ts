import request from "supertest";
import express from "express";
import cors from "cors";

function createApp(frontendUrl: string) {
  const app = express();
  app.use(cors({ origin: frontendUrl }));
  app.get("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS configuration", () => {
  it("includes Access-Control-Allow-Origin header", async () => {
    const app = createApp("http://localhost:3000");
    const res = await request(app)
      .get("/test")
      .set("Origin", "http://localhost:3000")
      .expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("header value matches configured FRONTEND_URL", async () => {
    const frontendUrl = "https://app.heliobond.io";
    const app = createApp(frontendUrl);
    const res = await request(app)
      .get("/test")
      .set("Origin", frontendUrl)
      .expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe(frontendUrl);
  });

  it("handles OPTIONS preflight requests", async () => {
    const app = createApp("http://localhost:3000");
    const res = await request(app)
      .options("/test")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "GET");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
});
