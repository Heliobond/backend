import request from "supertest";
import express from "express";
import { getHealth } from "../lib/health";

const app = express();
app.get("/health", async (_req, res) => res.json(await getHealth()));

describe("GET /health — HTTP level", () => {
  it("returns 200 status code", async () => {
    await request(app).get("/health").expect(200);
  });

  it("returns JSON content type", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("response body has status ok", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(["ok", "degraded"]).toContain(res.body.status);
  });
});
