import request from "supertest";
import express from "express";
import { errorHandler } from "../middleware/errors";

describe("request body size limit", () => {
  it("allows a small body to succeed", async () => {
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.post("/test", (req, res) => res.json({ received: true }));
    app.use(errorHandler);

    const res = await request(app)
      .post("/test")
      .send({ name: "test", value: 42 })
      .expect(200);

    expect(res.body.received).toBe(true);
  });

  it("rejects a body that exceeds the limit with 413", async () => {
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.post("/test", (req, res) => res.json({ received: true }));
    app.use(errorHandler);

    const largeBody = { data: "x".repeat(200 * 1024) };
    const res = await request(app)
      .post("/test")
      .send(largeBody)
      .expect(413);

    expect(res.body).toEqual({
      error: { code: "payload_too_large", message: "Request body is too large" },
    });
  });

  it("respects a configurable limit via env var", async () => {
    const app = express();
    app.use(express.json({ limit: "100b" }));
    app.post("/test", (req, res) => res.json({ received: true }));
    app.use(errorHandler);

    const smallEnough = { data: "x".repeat(50) };
    const tooLarge = { data: "x".repeat(200) };

    const ok = await request(app)
      .post("/test")
      .send(smallEnough)
      .expect(200);
    expect(ok.body.received).toBe(true);

    const rejected = await request(app)
      .post("/test")
      .send(tooLarge)
      .expect(413);

    expect(rejected.body).toEqual({
      error: { code: "payload_too_large", message: "Request body is too large" },
    });
  });
});