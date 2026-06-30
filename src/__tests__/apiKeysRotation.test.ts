import express from "express";
import request from "supertest";
import {
  generateApiKey,
  rotateApiKey,
  validateApiKey,
  clearApiKeys,
  checkScheduledRotations,
  getRotationStatus,
  onRotation,
} from "../lib/apiKeys";
import apiKeysRouter from "../routes/apiKeys";

describe("API Key Rotation", () => {
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

  describe("Scheduled Rotation", () => {
    it("should set next_rotation_at when rotation_interval_days is provided", () => {
      const key = generateApiKey("Consumer", 100, 30);
      expect(key.rotation_interval_days).toBe(30);
      expect(key.next_rotation_at).toBeDefined();
      expect(key.next_rotation_at).toBeGreaterThan(Date.now());
    });

    it("should not set rotation schedule when rotation_interval_days is not provided", () => {
      const key = generateApiKey("Consumer", 100);
      expect(key.rotation_interval_days).toBeUndefined();
      expect(key.next_rotation_at).toBeUndefined();
    });

    it("should rotate keys that have passed their rotation time", () => {
      const key = generateApiKey("Consumer", 100, 1);
      const oldKey = key.key;

      // Simulate time passing by setting next_rotation_at to past
      key.next_rotation_at = Date.now() - 1000;

      const rotated = checkScheduledRotations();
      expect(rotated.length).toBe(1);
      expect(rotated[0].key).not.toBe(oldKey);
    });

    it("should not rotate keys that are still within rotation interval", () => {
      generateApiKey("Consumer", 100, 30);

      const rotated = checkScheduledRotations();
      expect(rotated.length).toBe(0);
    });

    it("should return correct rotation status", () => {
      generateApiKey("Consumer1", 100, 30);
      generateApiKey("Consumer2", 100, 7);
      generateApiKey("Consumer3", 100);

      const status = getRotationStatus();
      expect(status.keys_with_scheduled_rotation).toBe(2);
      expect(status.keys_pending_rotation).toBe(0);
      expect(status.next_rotation_at).toBeDefined();
    });
  });

  describe("Grace Period Rotation", () => {
    it("should accept old key during grace period", () => {
      const key = generateApiKey("Consumer", 100);
      const oldKey = key.key;
      const gracePeriodMs = 60 * 60 * 1000; // 1 hour

      rotateApiKey(key.id, gracePeriodMs);

      // Old key should still be valid
      expect(validateApiKey(oldKey)).not.toBeNull();
      // New key should also be valid
      const updatedKey = validateApiKey(key.key);
      expect(updatedKey).not.toBeNull();
    });

    it("should reject old key after grace period expires", () => {
      const key = generateApiKey("Consumer", 100);
      const oldKey = key.key;

      // Rotate with 0ms grace period (effectively no grace)
      rotateApiKey(key.id, 0);

      // Old key should be invalid immediately
      expect(validateApiKey(oldKey)).toBeNull();
    });
  });

  describe("Rotation Notifications", () => {
    it("should emit rotation notification", () => {
      const notifications: any[] = [];
      onRotation((n) => notifications.push(n));

      const key = generateApiKey("Consumer", 100);
      rotateApiKey(key.id);

      expect(notifications.length).toBe(1);
      expect(notifications[0].key_id).toBe(key.id);
      expect(notifications[0].consumer_name).toBe("Consumer");
    });
  });

  describe("API Routes with Rotation", () => {
    const app = express();
    app.use(express.json());
    app.use("/admin/api-keys", apiKeysRouter);

    it("should create key with rotation interval", async () => {
      const res = await request(app)
        .post("/admin/api-keys")
        .set("Authorization", "Bearer admin-secret-key")
        .send({ consumer_name: "Test Consumer", rotation_interval_days: 30 });

      expect(res.status).toBe(201);
      expect(res.body.rotation_interval_days).toBe(30);
      expect(res.body.next_rotation_at).toBeDefined();
    });

    it("should return rotation status", async () => {
      generateApiKey("Consumer 1", 100, 30);
      generateApiKey("Consumer 2", 100, 7);

      const res = await request(app)
        .get("/admin/api-keys/rotation/status")
        .set("Authorization", "Bearer admin-secret-key");

      expect(res.status).toBe(200);
      expect(res.body.keys_with_scheduled_rotation).toBe(2);
    });

    it("should trigger manual rotation", async () => {
      const res = await request(app)
        .post("/admin/api-keys/rotation/trigger")
        .set("Authorization", "Bearer admin-secret-key");

      expect(res.status).toBe(200);
      expect(res.body.rotated).toBe(0);
    });

    it("should rotate key with grace period", async () => {
      const key = generateApiKey("Consumer", 100);

      const res = await request(app)
        .post(`/admin/api-keys/${key.id}/rotate`)
        .set("Authorization", "Bearer admin-secret-key")
        .send({ grace_period_ms: 3600000 });

      expect(res.status).toBe(200);
      expect(res.body.old_key).toBeDefined();
      expect(res.body.new_key_expires_at).toBeDefined();
    });

    it("should include rotation info in key details", async () => {
      const key = generateApiKey("Consumer", 100, 30);

      const res = await request(app)
        .get(`/admin/api-keys/${key.id}/usage`)
        .set("Authorization", "Bearer admin-secret-key");

      expect(res.status).toBe(200);
      expect(res.body.rotation_interval_days).toBe(30);
      expect(res.body.next_rotation_at).toBeDefined();
    });
  });
});
