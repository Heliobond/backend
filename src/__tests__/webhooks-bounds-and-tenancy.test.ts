import request from "supertest";
import express, { Express } from "express";
import { createHmac } from "crypto";
import webhooksRouter, {
  MAX_ALLOWED_RETRIES,
  MIN_ALLOWED_RETRY_DELAY_MS,
  MAX_ALLOWED_RETRY_DELAY_MS,
} from "../routes/webhooks";
import { clearWebhooks } from "../lib/webhooks";
import { errorHandler } from "../middleware/errors";
import { requestSigning } from "../middleware/requestSigning";

const SIGNING_SECRET = "test-webhook-signing-secret-32-chars-long";

function buildApp(withSigning = false): Express {
  const app = express();
  app.use(express.json());
  if (withSigning) {
    app.use("/api/webhooks", requestSigning, webhooksRouter);
  } else {
    app.use("/api/webhooks", webhooksRouter);
  }
  app.use(errorHandler);
  return app;
}

function computeTestSignature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: any,
): string {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const payload = `${timestamp}:${method}:${path}:${bodyStr}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("Webhooks Bounds, Tenant Isolation & Signing Parity (#886)", () => {
  let app: Express;

  beforeEach(() => {
    clearWebhooks();
    app = buildApp(false);
  });

  describe("Dimension 1: Boundaries & Clamping (max_retries and retry_delay_ms bounds)", () => {
    const invalidRetries = [
      -1,
      -10,
      11,
      12,
      20,
      100,
      1000,
      1_000_000_000, // Explicitly mentioned in issue #886
      1.5,
      NaN,
      Infinity,
    ];

    it.each(invalidRetries)(
      "rejects out-of-range or invalid max_retries: %s with HTTP 400",
      async (badRetry) => {
        const res = await request(app).post("/api/webhooks").send({
          url: "https://example.com/hook",
          secret: "my-super-secret-key-16",
          max_retries: badRetry,
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.message).toMatch(/max_retries must be an integer between 0 and 10/);
      },
    );

    const validRetries = [0, 1, 2, 3, 5, 8, 9, 10];

    it.each(validRetries)(
      "accepts valid bounded max_retries: %d with HTTP 201",
      async (validRetry) => {
        const res = await request(app)
          .post("/api/webhooks")
          .send({
            url: `https://example.com/hook-retry-${validRetry}`,
            secret: "my-super-secret-key-16",
            max_retries: validRetry,
          });

        expect(res.status).toBe(201);
        expect(res.body.max_retries).toBe(validRetry);
      },
    );

    const invalidDelays = [
      -1,
      0,
      1, // Explicitly mentioned in issue #886: retry_delay_ms: 1 creates retry storm
      50,
      99,
      60001,
      70000,
      100000,
      1_000_000,
      100.5,
      NaN,
      Infinity,
    ];

    it.each(invalidDelays)(
      "rejects out-of-range or invalid retry_delay_ms: %s with HTTP 400",
      async (badDelay) => {
        const res = await request(app).post("/api/webhooks").send({
          url: "https://example.com/hook",
          secret: "my-super-secret-key-16",
          retry_delay_ms: badDelay,
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.message).toMatch(
          /retry_delay_ms must be an integer between 100 and 60000/,
        );
      },
    );

    const validDelays = [100, 200, 500, 1000, 2000, 5000, 30000, 59999, 60000];

    it.each(validDelays)(
      "accepts valid bounded retry_delay_ms: %d with HTTP 201",
      async (validDelay) => {
        const res = await request(app)
          .post("/api/webhooks")
          .send({
            url: `https://example.com/hook-delay-${validDelay}`,
            secret: "my-super-secret-key-16",
            retry_delay_ms: validDelay,
          });

        expect(res.status).toBe(201);
        expect(res.body.retry_delay_ms).toBe(validDelay);
      },
    );

    it("defaults max_retries=3 and retry_delay_ms=2000 when unprovided", async () => {
      const res = await request(app).post("/api/webhooks").send({
        url: "https://example.com/hook-default",
        secret: "my-super-secret-key-16",
      });

      expect(res.status).toBe(201);
      expect(res.body.max_retries).toBe(3);
      expect(res.body.retry_delay_ms).toBe(2000);
    });
  });

  describe("Dimension 2: Combinatorics & Multi-Tenant Ownership Isolation", () => {
    it("scopes list and delete operations strictly to the registering tenant", async () => {
      // Tenant Alpha registers a webhook
      const alphaCreate = await request(app)
        .post("/api/webhooks")
        .set("x-tenant-id", "tenant-alpha")
        .send({ url: "https://example.com/alpha-hook", secret: "my-super-secret-key-16" })
        .expect(201);

      // Tenant Beta registers a webhook
      const betaCreate = await request(app)
        .post("/api/webhooks")
        .set("x-tenant-id", "tenant-beta")
        .send({ url: "https://example.com/beta-hook", secret: "my-super-secret-key-16" })
        .expect(201);

      // Tenant Alpha lists webhooks -> only sees alpha
      const alphaList = await request(app)
        .get("/api/webhooks")
        .set("x-tenant-id", "tenant-alpha")
        .expect(200);

      expect(alphaList.body.webhooks).toHaveLength(1);
      expect(alphaList.body.webhooks[0].id).toBe(alphaCreate.body.id);
      expect(alphaList.body.webhooks[0].url).toBe("https://example.com/alpha-hook");

      // Tenant Beta lists webhooks -> only sees beta
      const betaList = await request(app)
        .get("/api/webhooks")
        .set("x-tenant-id", "tenant-beta")
        .expect(200);

      expect(betaList.body.webhooks).toHaveLength(1);
      expect(betaList.body.webhooks[0].id).toBe(betaCreate.body.id);
      expect(betaList.body.webhooks[0].url).toBe("https://example.com/beta-hook");

      // Tenant Beta attempts to GET Tenant Alpha's webhook -> 404
      await request(app)
        .get(`/api/webhooks/${alphaCreate.body.id}`)
        .set("x-tenant-id", "tenant-beta")
        .expect(404);

      // Tenant Beta attempts to DELETE Tenant Alpha's webhook -> 404
      await request(app)
        .delete(`/api/webhooks/${alphaCreate.body.id}`)
        .set("x-tenant-id", "tenant-beta")
        .expect(404);

      // Verify Tenant Alpha's webhook is still intact
      const alphaVerify = await request(app)
        .get(`/api/webhooks/${alphaCreate.body.id}`)
        .set("x-tenant-id", "tenant-alpha")
        .expect(200);

      expect(alphaVerify.body.id).toBe(alphaCreate.body.id);

      // Tenant Alpha deletes own webhook -> 200
      await request(app)
        .delete(`/api/webhooks/${alphaCreate.body.id}`)
        .set("x-tenant-id", "tenant-alpha")
        .expect(200);

      // Now it is gone
      await request(app)
        .get(`/api/webhooks/${alphaCreate.body.id}`)
        .set("x-tenant-id", "tenant-alpha")
        .expect(404);
    });

    const tenantChannels = [
      { name: "x-tenant-id", header: "x-tenant-id", val: "channel-tenant-1" },
      { name: "x-consumer-name", header: "x-consumer-name", val: "channel-consumer-2" },
      { name: "x-consumer-id", header: "x-consumer-id", val: "channel-id-3" },
    ];

    it.each(tenantChannels)(
      "correctly resolves owner via channel $name",
      async ({ header, val }) => {
        const create = await request(app)
          .post("/api/webhooks")
          .set(header, val)
          .send({ url: "https://example.com/channel-hook", secret: "my-super-secret-key-16" })
          .expect(201);

        expect(create.body.owner).toBe(val);

        const fetchRes = await request(app)
          .get(`/api/webhooks/${create.body.id}`)
          .set(header, val)
          .expect(200);

        expect(fetchRes.body.owner).toBe(val);
      },
    );
  });

  describe("Dimension 3: Host Variations & Request Signing Parity", () => {
    let signedApp: Express;

    beforeEach(() => {
      process.env.REQUEST_SIGNING_SECRET = SIGNING_SECRET;
      signedApp = buildApp(true);
    });

    afterEach(() => {
      delete process.env.REQUEST_SIGNING_SECRET;
    });

    it("rejects request to /api/webhooks without signature headers when signing is enabled", async () => {
      await request(signedApp)
        .post("/api/webhooks")
        .send({ url: "https://example.com/unauthenticated", secret: "my-super-secret-key-16" })
        .expect(401);
    });

    it("rejects request with expired timestamp (> 5 min)", async () => {
      const expiredTimestamp = String(Date.now() - 10 * 60 * 1000);
      const sig = computeTestSignature(SIGNING_SECRET, expiredTimestamp, "POST", "/api/webhooks", {
        url: "https://example.com/expired",
        secret: "my-super-secret-key-16",
      });

      await request(signedApp)
        .post("/api/webhooks")
        .set("x-timestamp", expiredTimestamp)
        .set("x-signature", sig)
        .send({ url: "https://example.com/expired", secret: "my-super-secret-key-16" })
        .expect(401);
    });

    it("rejects request with invalid signature", async () => {
      const now = String(Date.now());
      await request(signedApp)
        .post("/api/webhooks")
        .set("x-timestamp", now)
        .set("x-signature", "deadbeef00000000000000000000000000000000000000000000000000000000")
        .send({ url: "https://example.com/tampered", secret: "my-super-secret-key-16" })
        .expect(401);
    });

    it("accepts request with valid timestamp and signature", async () => {
      const now = String(Date.now());
      const body = { url: "https://example.com/signed-ok", secret: "my-super-secret-key-16" };
      const sig = computeTestSignature(SIGNING_SECRET, now, "POST", "/", body);

      const res = await request(signedApp)
        .post("/api/webhooks")
        .set("x-timestamp", now)
        .set("x-signature", sig)
        .send(body)
        .expect(201);

      expect(res.body.url).toBe("https://example.com/signed-ok");
    });
  });

  describe("Dimension 4: Negative Controls & Non-mutation", () => {
    it("does not register a webhook when validation fails", async () => {
      await request(app)
        .post("/api/webhooks")
        .send({
          url: "https://example.com/invalid-delay",
          secret: "my-super-secret-key-16",
          retry_delay_ms: 1, // Invalid
        })
        .expect(400);

      const list = await request(app).get("/api/webhooks").expect(200);
      expect(list.body.webhooks).toHaveLength(0);
    });

    it("never exposes the webhook secret in any response payload", async () => {
      const secret = "super-confidential-secret-payload-12345";
      const create = await request(app)
        .post("/api/webhooks")
        .send({ url: "https://example.com/secret-check", secret })
        .expect(201);

      expect(create.body).not.toHaveProperty("secret");
      expect(JSON.stringify(create.body)).not.toContain(secret);

      const fetchSingle = await request(app).get(`/api/webhooks/${create.body.id}`).expect(200);

      expect(fetchSingle.body).not.toHaveProperty("secret");
      expect(JSON.stringify(fetchSingle.body)).not.toContain(secret);

      const listRes = await request(app).get("/api/webhooks").expect(200);
      expect(JSON.stringify(listRes.body)).not.toContain(secret);
    });
  });

  describe("Dimension 5: Stress, Concurrency & High-volume lifecycle", () => {
    it.each(Array.from({ length: 50 }, (_, i) => i + 1))(
      "rapid registration and teardown cycle #%d",
      async (i) => {
        const retries = (i % 10) + 1; // 1 to 10
        const delay = 100 + (i % 50) * 100; // 100 to 5000
        const tenant = `stress-tenant-${i % 5}`;

        const create = await request(app)
          .post("/api/webhooks")
          .set("x-tenant-id", tenant)
          .send({
            url: `https://example.com/stress-${i}`,
            secret: "my-super-secret-key-16",
            max_retries: retries,
            retry_delay_ms: delay,
          })
          .expect(201);

        expect(create.body.max_retries).toBe(retries);
        expect(create.body.retry_delay_ms).toBe(delay);
        expect(create.body.owner).toBe(tenant);

        // Delete immediately
        await request(app)
          .delete(`/api/webhooks/${create.body.id}`)
          .set("x-tenant-id", tenant)
          .expect(200);
      },
    );

    it("handles 20 concurrent registrations across 5 tenants maintaining strict isolation", async () => {
      const createPromises = Array.from({ length: 20 }, (_, idx) => {
        const tenant = `concurrent-tenant-${idx % 5}`;
        return request(app)
          .post("/api/webhooks")
          .set("x-tenant-id", tenant)
          .send({
            url: `https://example.com/concurrent-${idx}`,
            secret: "my-super-secret-key-16",
            max_retries: 3,
            retry_delay_ms: 1000,
          });
      });

      const responses = await Promise.all(createPromises);
      responses.forEach((res) => {
        expect(res.status).toBe(201);
      });

      // Query each of the 5 tenants
      const queryPromises = Array.from({ length: 5 }, (_, tenantIdx) => {
        const tenant = `concurrent-tenant-${tenantIdx}`;
        return request(app).get("/api/webhooks").set("x-tenant-id", tenant);
      });

      const listResponses = await Promise.all(queryPromises);
      listResponses.forEach((res) => {
        expect(res.status).toBe(200);
        // Each tenant created 4 webhooks (20 / 5)
        expect(res.body.webhooks).toHaveLength(4);
      });
    });
  });
});
