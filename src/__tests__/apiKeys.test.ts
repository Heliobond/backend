import express from "express";
import request from "supertest";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/apiKeyAuth";
import { clearApiKeys, generateApiKey, validateApiKey } from "../lib/apiKeys";
import apiKeysRouter from "../routes/apiKeys";

describe("API Key Management and Authentication", () => {
  let originalAdminKey: string | undefined;

  beforeAll(() => {
    originalAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = "admin-secret-key";
  });

  afterAll(() => {
    process.env.ADMIN_API_KEY = originalAdminKey;
  });

  beforeEach(() => {
    clearApiKeys();
  });

  describe("API Key Admin Routes", () => {
    const app = express();
    app.use(express.json());
    app.use("/admin/api-keys", apiKeysRouter);

    it("should reject unauthorized requests to key management", async () => {
      const res = await request(app)
        .post("/admin/api-keys")
        .send({ consumer_name: "Test Consumer" });
      expect(res.status).toBe(401);
    });

    it("should allow key generation when authorized as admin", async () => {
      const res = await request(app)
        .post("/admin/api-keys")
        .set("Authorization", "Bearer admin-secret-key")
        .send({ consumer_name: "Test Consumer", rate_limit: 5 });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("key");
      expect(res.body.consumer_name).toBe("Test Consumer");
      expect(res.body.rate_limit).toBe(5);
    });

    it("should list generated keys", async () => {
      generateApiKey("Consumer 1");
      generateApiKey("Consumer 2");

      const res = await request(app)
        .get("/admin/api-keys")
        .set("Authorization", "Bearer admin-secret-key");

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.keys.length).toBe(2);
    });

    it("should rotate an existing key", async () => {
      const key = generateApiKey("Consumer To Rotate");
      const oldKeyString = key.key;

      const res = await request(app)
        .post(`/admin/api-keys/${key.id}/rotate`)
        .set("Authorization", "Bearer admin-secret-key");

      expect(res.status).toBe(200);
      expect(res.body.key).not.toBe(oldKeyString);
      expect(validateApiKey(oldKeyString)).toBeNull();
      expect(validateApiKey(res.body.key)).not.toBeNull();
    });

    it("should revoke an existing key", async () => {
      const key = generateApiKey("Consumer To Revoke");

      const res = await request(app)
        .delete(`/admin/api-keys/${key.id}`)
        .set("Authorization", "Bearer admin-secret-key");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(validateApiKey(key.key)).toBeNull();
    });

    it("should return usage stats", async () => {
      const key = generateApiKey("Consumer Stats", 10);
      
      const res = await request(app)
        .get(`/admin/api-keys/${key.id}/usage`)
        .set("Authorization", "Bearer admin-secret-key");

      expect(res.status).toBe(200);
      expect(res.body.usage_count).toBe(0);
      expect(res.body.rate_limit).toBe(10);
    });
  });

  describe("API Key Authentication Middleware", () => {
    const app = express();
    app.use(express.json());
    app.get("/protected", apiKeyAuth as any, (req: AuthenticatedRequest, res: Response | any) => {
      res.json({ success: true, consumer: req.apiKeyInfo?.consumer_name });
    });

    it("should block requests with no key", async () => {
      const res = await request(app).get("/protected");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    });

    it("should accept valid consumer key and record usage", async () => {
      const key = generateApiKey("Authenticated Consumer");

      const res = await request(app)
        .get("/protected")
        .set("X-API-Key", key.key);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.consumer).toBe("Authenticated Consumer");

      expect(validateApiKey(key.key)?.usage_count).toBe(1);
    });

    it("should enforce rate limits per key", async () => {
      const key = generateApiKey("Rate Limited Consumer", 3);

      // Request 1, 2, 3 -> Allowed
      await request(app).get("/protected").set("X-API-Key", key.key);
      await request(app).get("/protected").set("X-API-Key", key.key);
      const res3 = await request(app).get("/protected").set("X-API-Key", key.key);
      expect(res3.status).toBe(200);

      // Request 4 -> Blocked (429)
      const res4 = await request(app).get("/protected").set("X-API-Key", key.key);
      expect(res4.status).toBe(429);
      expect(res4.body.error).toBe("too_many_requests");
    });
  });
});
