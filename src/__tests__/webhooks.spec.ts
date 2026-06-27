import request from "supertest";
import express, { Express } from "express";
import webhooksRouter from "../routes/webhooks";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/webhooks", webhooksRouter);
  app.use(errorHandler);
  return app;
}

describe("webhooks routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("POST /api/webhooks — registers a webhook and returns id", async () => {
    const res = await request(app)
      .post("/api/webhooks")
      .send({ url: "https://example.com/hook", secret: "my-super-secret-key" })
      .expect(201);

    expect(res.body).toMatchObject({
      id: expect.stringContaining("wh_"),
      url: "https://example.com/hook",
      max_retries: 3,
      retry_delay_ms: 2000,
    });
    expect(res.body).not.toHaveProperty("secret");
  });

  it("POST /api/webhooks — rejects short secret", async () => {
    await request(app)
      .post("/api/webhooks")
      .send({ url: "https://example.com/hook", secret: "short" })
      .expect(400);
  });

  it("POST /api/webhooks — rejects invalid URL", async () => {
    await request(app)
      .post("/api/webhooks")
      .send({ url: "not-a-url", secret: "my-super-secret-key" })
      .expect(400);
  });

  it("GET /api/webhooks — lists registered webhooks without secrets", async () => {
    await request(app)
      .post("/api/webhooks")
      .send({ url: "https://example.com/list-test", secret: "my-super-secret-key" });

    const res = await request(app).get("/api/webhooks").expect(200);
    expect(res.body.webhooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "https://example.com/list-test" }),
      ]),
    );
    res.body.webhooks.forEach((wh: Record<string, unknown>) => {
      expect(wh).not.toHaveProperty("secret");
    });
  });

  it("DELETE /api/webhooks/:id — removes a registered webhook", async () => {
    const create = await request(app)
      .post("/api/webhooks")
      .send({ url: "https://example.com/delete-test", secret: "my-super-secret-key" });

    await request(app)
      .delete(`/api/webhooks/${create.body.id}`)
      .expect(200)
      .expect({ removed: true });
  });

  it("DELETE /api/webhooks/:id — 404 for unknown id", async () => {
    await request(app).delete("/api/webhooks/nonexistent").expect(404);
  });

  it("GET /api/webhooks/:id — returns a single webhook without secret", async () => {
    const create = await request(app)
      .post("/api/webhooks")
      .send({ url: "https://example.com/single", secret: "my-super-secret-key" });

    const res = await request(app)
      .get(`/api/webhooks/${create.body.id}`)
      .expect(200);
    expect(res.body.url).toBe("https://example.com/single");
    expect(res.body).not.toHaveProperty("secret");
  });
});
