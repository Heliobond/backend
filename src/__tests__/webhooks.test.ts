import request from "supertest";
import express, { Express } from "express";
import webhooksRouter from "../routes/webhooks";
import { errorHandler } from "../middleware/errors";
import {
  registerWebhook,
  getWebhook,
  removeWebhook,
  listWebhooks,
  cleanupStaleWebhooks,
  WEBHOOK_MAX_CONSECUTIVE_FAILURES,
  WEBHOOK_MAX_STORE_SIZE,
} from "../lib/webhooks";
import { config } from "../config";

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

  it("POST /api/webhooks — rejects non-http(s) protocols", async () => {
    await request(app)
      .post("/api/webhooks")
      .send({ url: "ftp://example.com/hook", secret: "my-super-secret-key" })
      .expect(400);
  });

  it("POST /api/webhooks — rejects strings merely starting with 'http'", async () => {
    await request(app)
      .post("/api/webhooks")
      .send({ url: "httpanything", secret: "my-super-secret-key" })
      .expect(400);
  });

  it("POST /api/webhooks — rejects loopback URLs", async () => {
    await request(app)
      .post("/api/webhooks")
      .send({ url: "http://127.0.0.1/hook", secret: "my-super-secret-key" })
      .expect(400);
  });

  it("POST /api/webhooks — rejects private IP URLs", async () => {
    await request(app)
      .post("/api/webhooks")
      .send({ url: "http://10.0.0.1/hook", secret: "my-super-secret-key" })
      .expect(400);
  });

  it("POST /api/webhooks — rejects link-local / metadata URLs", async () => {
    await request(app)
      .post("/api/webhooks")
      .send({ url: "http://169.254.169.254/latest/meta-data", secret: "my-super-secret-key" })
      .expect(400);
  });

  it("POST /api/webhooks — rejects IPv6 loopback URLs", async () => {
    await request(app)
      .post("/api/webhooks")
      .send({ url: "http://[::1]/hook", secret: "my-super-secret-key" })
      .expect(400);
  });

  it("GET /api/webhooks — lists registered webhooks without secrets", async () => {
    await request(app)
      .post("/api/webhooks")
      .send({ url: "https://example.com/list-test", secret: "my-super-secret-key" });

    const res = await request(app).get("/api/webhooks").expect(200);
    expect(res.body.webhooks).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: "https://example.com/list-test" })]),
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

    const res = await request(app).get(`/api/webhooks/${create.body.id}`).expect(200);
    expect(res.body.url).toBe("https://example.com/single");
    expect(res.body).not.toHaveProperty("secret");
  });
});

describe("cleanupStaleWebhooks", () => {
  const createdIds: string[] = [];

  afterEach(() => {
    for (const id of createdIds.splice(0)) {
      removeWebhook(id);
    }
  });

  function registerOld(): string {
    const wh = registerWebhook("https://example.com/stale", "my-super-secret-key");
    createdIds.push(wh.id);
    return wh.id;
  }

  function staleDate(): string {
    return new Date(Date.now() - config.WEBHOOK_STALE_THRESHOLD_MS - 1000).toISOString();
  }

  it("removes a webhook that never delivered once it passes the threshold", () => {
    const id = registerOld();
    const stored = getWebhook(id);
    if (!stored) throw new Error("webhook was not registered");
    stored.created_at = staleDate();

    cleanupStaleWebhooks();

    expect(getWebhook(id)).toBeUndefined();
  });

  it("keeps a recently created webhook that never delivered", () => {
    const id = registerOld();

    cleanupStaleWebhooks();

    expect(getWebhook(id)).toBeDefined();
  });

  it("removes a once-working webhook that went quiet past the threshold", () => {
    const id = registerOld();
    const stored = getWebhook(id);
    if (!stored) throw new Error("webhook was not registered");
    stored.last_triggered_at = staleDate();

    cleanupStaleWebhooks();

    expect(getWebhook(id)).toBeUndefined();
  });

  it("keeps a webhook that delivered recently", () => {
    const id = registerOld();
    const stored = getWebhook(id);
    if (!stored) throw new Error("webhook was not registered");
    stored.last_triggered_at = new Date().toISOString();

    cleanupStaleWebhooks();

    expect(getWebhook(id)).toBeDefined();
  });

  it("drops a webhook after the consecutive failure cap", () => {
    const id = registerOld();
    const stored = getWebhook(id);
    if (!stored) throw new Error("webhook was not registered");
    stored.consecutive_failures = WEBHOOK_MAX_CONSECUTIVE_FAILURES;

    cleanupStaleWebhooks();

    expect(getWebhook(id)).toBeUndefined();
  });

  it("evicts the oldest webhook when the store is at capacity", () => {
    const oldestBefore = listWebhooks()[0]?.id;
    const before = listWebhooks().length;
    const first = registerOld();
    for (let i = 0; i < WEBHOOK_MAX_STORE_SIZE - before; i++) {
      createdIds.push(registerWebhook("https://example.com/fill", "my-super-secret-key").id);
    }

    expect(listWebhooks().length).toBe(WEBHOOK_MAX_STORE_SIZE);
    if (oldestBefore) {
      expect(getWebhook(oldestBefore)).toBeUndefined();
    } else {
      expect(getWebhook(first)).toBeUndefined();
    }
  });
});
