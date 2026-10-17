import express from "express";
import request from "supertest";
import {
  clearApiKeys,
  generateApiKey,
  getApiKeyDetails,
  rotateApiKey,
  validateApiKey,
} from "../lib/apiKeys";
import apiKeysRouter, {
  MAX_CONSUMER_NAME_LENGTH,
  MAX_GRACE_PERIOD_MS,
  MAX_RATE_LIMIT,
  MAX_ROTATION_INTERVAL_DAYS,
} from "../routes/apiKeys";
import { errorHandler } from "../middleware/errors";

describe("API Key Management 5D Matrix - Bounds, Validation & Resilience", () => {
  let originalAdminKey: string | undefined;
  let app: express.Express;

  beforeAll(() => {
    originalAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = "admin-test-secret";

    app = express();
    app.use(express.json());
    app.use("/admin/api-keys", apiKeysRouter);
    app.use(errorHandler);
  });

  afterAll(() => {
    process.env.ADMIN_API_KEY = originalAdminKey;
  });

  beforeEach(() => {
    clearApiKeys();
  });

  // =========================================================================
  // DIMENSION 1: BOUNDARY & CLAMPING TESTS
  // =========================================================================
  describe("Dimension 1: Boundary & Clamping", () => {
    describe("Consumer name length boundary tests", () => {
      const validLengths = [
        { desc: "single char (min)", len: 1 },
        { desc: "2 chars", len: 2 },
        { desc: "64 chars (half)", len: 64 },
        { desc: "127 chars (max - 1)", len: MAX_CONSUMER_NAME_LENGTH - 1 },
        { desc: "128 chars (exact max)", len: MAX_CONSUMER_NAME_LENGTH },
      ];

      test.each(validLengths)(
        "accepts consumer_name with $desc",
        async ({ len }) => {
          const name = "A".repeat(len);
          const res = await request(app)
            .post("/admin/api-keys")
            .set("Authorization", "Bearer admin-test-secret")
            .send({ consumer_name: name });

          expect(res.status).toBe(201);
          expect(res.body.consumer_name).toBe(name);
        },
      );

      const invalidLengths = [
        { desc: "129 chars (max + 1)", len: MAX_CONSUMER_NAME_LENGTH + 1 },
        { desc: "200 chars", len: 200 },
        { desc: "1000 chars", len: 1000 },
        { desc: "5000 chars (oversized)", len: 5000 },
      ];

      test.each(invalidLengths)(
        "rejects consumer_name with $desc with 400",
        async ({ len }) => {
          const name = "X".repeat(len);
          const res = await request(app)
            .post("/admin/api-keys")
            .set("Authorization", "Bearer admin-test-secret")
            .send({ consumer_name: name });

          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe("bad_request");
          expect(res.body.error.message).toContain("must not exceed");
        },
      );

      const emptyOrWhitespaceNames = [
        { desc: "empty string", val: "" },
        { desc: "single space", val: " " },
        { desc: "multiple spaces", val: "    " },
        { desc: "tab character", val: "\t" },
        { desc: "newline character", val: "\n" },
        { desc: "mixed whitespaces", val: "  \t \n  " },
      ];

      test.each(emptyOrWhitespaceNames)(
        "rejects consumer_name when $desc with 400",
        async ({ val }) => {
          const res = await request(app)
            .post("/admin/api-keys")
            .set("Authorization", "Bearer admin-test-secret")
            .send({ consumer_name: val });

          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe("bad_request");
        },
      );
    });

    describe("Rate limit range and boundary tests", () => {
      const validRateLimits = [
        { desc: "min valid 1", val: 1 },
        { desc: "standard 10", val: 10 },
        { desc: "standard 100", val: 100 },
        { desc: "large 10000", val: 10000 },
        { desc: "max - 1 (999,999)", val: MAX_RATE_LIMIT - 1 },
        { desc: "exact max (1,000,000)", val: MAX_RATE_LIMIT },
      ];

      test.each(validRateLimits)(
        "accepts rate_limit $desc",
        async ({ val }) => {
          const res = await request(app)
            .post("/admin/api-keys")
            .set("Authorization", "Bearer admin-test-secret")
            .send({ consumer_name: "valid-consumer", rate_limit: val });

          expect(res.status).toBe(201);
          expect(res.body.rate_limit).toBe(val);
        },
      );

      const invalidRateLimits = [
        { desc: "zero", val: 0 },
        { desc: "negative -1", val: -1 },
        { desc: "negative -500", val: -500 },
        { desc: "max + 1 (1,000,001)", val: MAX_RATE_LIMIT + 1 },
        { desc: "absurd 10,000,000", val: 10_000_000 },
        { desc: "extreme 1e12", val: 1e12 },
        { desc: "float 0.5", val: 0.5 },
        { desc: "float 99.99", val: 99.99 },
        { desc: "float 1000000.1", val: 1000000.1 },
      ];

      test.each(invalidRateLimits)(
        "rejects rate_limit $desc with 400",
        async ({ val }) => {
          const res = await request(app)
            .post("/admin/api-keys")
            .set("Authorization", "Bearer admin-test-secret")
            .send({ consumer_name: "valid-consumer", rate_limit: val });

          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe("bad_request");
          expect(res.body.error.message).toContain("rate_limit");
        },
      );
    });

    describe("Rotation interval days boundary tests", () => {
      const validIntervals = [
        { desc: "min valid 1 day", val: 1 },
        { desc: "7 days", val: 7 },
        { desc: "30 days (default standard)", val: 30 },
        { desc: "90 days (quarterly)", val: 90 },
        { desc: "365 days (annual)", val: 365 },
        { desc: "max - 1 (3649 days)", val: MAX_ROTATION_INTERVAL_DAYS - 1 },
        { desc: "exact max (3650 days, 10 years)", val: MAX_ROTATION_INTERVAL_DAYS },
      ];

      test.each(validIntervals)(
        "accepts rotation_interval_days $desc",
        async ({ val }) => {
          const res = await request(app)
            .post("/admin/api-keys")
            .set("Authorization", "Bearer admin-test-secret")
            .send({ consumer_name: "valid-consumer", rotation_interval_days: val });

          expect(res.status).toBe(201);
          expect(res.body.rotation_interval_days).toBe(val);
          expect(res.body.next_rotation_at).toBeGreaterThan(Date.now());
        },
      );

      const invalidIntervals = [
        { desc: "zero days", val: 0 },
        { desc: "negative -1", val: -1 },
        { desc: "negative -30", val: -30 },
        { desc: "max + 1 (3651 days)", val: MAX_ROTATION_INTERVAL_DAYS + 1 },
        { desc: "absurd 5000 days", val: 5000 },
        { desc: "extreme 100000 days", val: 100000 },
        { desc: "float 0.5 days", val: 0.5 },
        { desc: "float 14.5 days", val: 14.5 },
      ];

      test.each(invalidIntervals)(
        "rejects rotation_interval_days $desc with 400",
        async ({ val }) => {
          const res = await request(app)
            .post("/admin/api-keys")
            .set("Authorization", "Bearer admin-test-secret")
            .send({ consumer_name: "valid-consumer", rotation_interval_days: val });

          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe("bad_request");
          expect(res.body.error.message).toContain("rotation_interval_days");
        },
      );
    });

    describe("Grace period ms boundary tests on rotate", () => {
      let keyId: string;

      beforeEach(() => {
        const key = generateApiKey("Grace-Test-Consumer");
        keyId = key.id;
      });

      const validGracePeriods = [
        { desc: "exact 0ms (immediate retirement)", val: 0 },
        { desc: "1ms", val: 1 },
        { desc: "1,000ms (1 second)", val: 1000 },
        { desc: "60,000ms (1 minute)", val: 60000 },
        { desc: "3,600,000ms (1 hour)", val: 3600000 },
        { desc: "86,400,000ms (1 day)", val: 86400000 },
        { desc: "exact max (30 days = 2,592,000,000ms)", val: MAX_GRACE_PERIOD_MS },
      ];

      test.each(validGracePeriods)(
        "accepts grace_period_ms $desc",
        async ({ val }) => {
          const nowBefore = Date.now();
          const res = await request(app)
            .post(`/admin/api-keys/${keyId}/rotate`)
            .set("Authorization", "Bearer admin-test-secret")
            .send({ grace_period_ms: val });

          expect(res.status).toBe(200);
          expect(res.body.id).toBe(keyId);
          if (val === 0) {
            expect(res.body.old_key).toBeUndefined();
            expect(res.body.new_key_expires_at).toBeUndefined();
          } else {
            expect(res.body.old_key).toBeDefined();
            expect(res.body.new_key_expires_at).toBeGreaterThanOrEqual(nowBefore + val);
          }
        },
      );

      const invalidGracePeriods = [
        { desc: "negative -1", val: -1 },
        { desc: "negative -60000", val: -60000 },
        { desc: "max + 1 ms", val: MAX_GRACE_PERIOD_MS + 1 },
        { desc: "absurd 100 days ms", val: 100 * 24 * 60 * 60 * 1000 },
        { desc: "extreme 1e15 ms", val: 1e15 },
        { desc: "float 0.5 ms", val: 0.5 },
        { desc: "float 1000.5 ms", val: 1000.5 },
      ];

      test.each(invalidGracePeriods)(
        "rejects grace_period_ms $desc with 400",
        async ({ val }) => {
          const res = await request(app)
            .post(`/admin/api-keys/${keyId}/rotate`)
            .set("Authorization", "Bearer admin-test-secret")
            .send({ grace_period_ms: val });

          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe("bad_request");
          expect(res.body.error.message).toContain("grace_period_ms");
        },
      );
    });
  });

  // =========================================================================
  // DIMENSION 2: COMBINATORICS
  // =========================================================================
  describe("Dimension 2: Combinatorics", () => {
    const validPairs = [
      { name: "short", rate: 1, rot: 1 },
      { name: "short", rate: 100, rot: 30 },
      { name: "short", rate: MAX_RATE_LIMIT, rot: MAX_ROTATION_INTERVAL_DAYS },
      { name: "M".repeat(64), rate: 500, rot: 14 },
      { name: "M".repeat(64), rate: 1000, rot: 365 },
      { name: "M".repeat(64), rate: MAX_RATE_LIMIT, rot: 1 },
      { name: "Z".repeat(MAX_CONSUMER_NAME_LENGTH), rate: 1, rot: MAX_ROTATION_INTERVAL_DAYS },
      { name: "Z".repeat(MAX_CONSUMER_NAME_LENGTH), rate: 10000, rot: 90 },
      { name: "Z".repeat(MAX_CONSUMER_NAME_LENGTH), rate: MAX_RATE_LIMIT, rot: 180 },
    ];

    test.each(validPairs)(
      "valid combo: name len %s, rate %s, rot %s",
      async ({ name, rate, rot }) => {
        const res = await request(app)
          .post("/admin/api-keys")
          .set("Authorization", "Bearer admin-test-secret")
          .send({ consumer_name: name, rate_limit: rate, rotation_interval_days: rot });

        expect(res.status).toBe(201);
        expect(res.body.rate_limit).toBe(rate);
        expect(res.body.rotation_interval_days).toBe(rot);
      },
    );

    const invalidMixedCombos = [
      {
        desc: "valid name & rate, invalid rot (0)",
        body: { consumer_name: "valid-name", rate_limit: 100, rotation_interval_days: 0 },
        field: "rotation_interval_days",
      },
      {
        desc: "valid name & rate, invalid rot (> 3650)",
        body: { consumer_name: "valid-name", rate_limit: 100, rotation_interval_days: 3651 },
        field: "rotation_interval_days",
      },
      {
        desc: "valid name & rate, invalid rot (negative)",
        body: { consumer_name: "valid-name", rate_limit: 100, rotation_interval_days: -5 },
        field: "rotation_interval_days",
      },
      {
        desc: "valid name & rot, invalid rate (0)",
        body: { consumer_name: "valid-name", rate_limit: 0, rotation_interval_days: 30 },
        field: "rate_limit",
      },
      {
        desc: "valid name & rot, invalid rate (> 1M)",
        body: { consumer_name: "valid-name", rate_limit: 1_000_001, rotation_interval_days: 30 },
        field: "rate_limit",
      },
      {
        desc: "valid name & rot, invalid rate (negative)",
        body: { consumer_name: "valid-name", rate_limit: -10, rotation_interval_days: 30 },
        field: "rate_limit",
      },
      {
        desc: "invalid name (empty), valid rate & rot",
        body: { consumer_name: "", rate_limit: 100, rotation_interval_days: 30 },
        field: "consumer_name",
      },
      {
        desc: "invalid name (too long), valid rate & rot",
        body: { consumer_name: "A".repeat(129), rate_limit: 100, rotation_interval_days: 30 },
        field: "consumer_name",
      },
      {
        desc: "all fields invalid",
        body: { consumer_name: "", rate_limit: -1, rotation_interval_days: -1 },
        field: "consumer_name",
      },
    ];

    test.each(invalidMixedCombos)(
      "rejects combo with 400 when $desc",
      async ({ body, field }) => {
        const res = await request(app)
          .post("/admin/api-keys")
          .set("Authorization", "Bearer admin-test-secret")
          .send(body);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("bad_request");
        expect(res.body.error.message).toContain(field);
      },
    );
  });

  // =========================================================================
  // DIMENSION 3: HOST VARIATIONS & TYPE COERCIONS
  // =========================================================================
  describe("Dimension 3: Host Variations & Type Coercions", () => {
    describe("consumer_name non-string types", () => {
      const nonStringNames = [
        { desc: "number 12345", val: 12345 },
        { desc: "boolean true", val: true },
        { desc: "boolean false", val: false },
        { desc: "null", val: null },
        { desc: "array ['svc']", val: ["svc"] },
        { desc: "object {name: 'svc'}", val: { name: "svc" } },
      ];

      test.each(nonStringNames)(
        "rejects consumer_name as $desc with 400",
        async ({ val }) => {
          const res = await request(app)
            .post("/admin/api-keys")
            .set("Authorization", "Bearer admin-test-secret")
            .send({ consumer_name: val });

          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe("bad_request");
        },
      );
    });

    describe("Numeric string coercions and non-numeric types", () => {
      test("accepts valid numeric string rate_limit", async () => {
        const res = await request(app)
          .post("/admin/api-keys")
          .set("Authorization", "Bearer admin-test-secret")
          .send({ consumer_name: "coercion-svc", rate_limit: "250" });

        expect(res.status).toBe(201);
        expect(res.body.rate_limit).toBe(250);
      });

      test("accepts valid numeric string rotation_interval_days", async () => {
        const res = await request(app)
          .post("/admin/api-keys")
          .set("Authorization", "Bearer admin-test-secret")
          .send({ consumer_name: "coercion-svc", rotation_interval_days: "60" });

        expect(res.status).toBe(201);
        expect(res.body.rotation_interval_days).toBe(60);
      });

      const badRateLimitTypes = [
        { desc: "non-numeric string 'fast'", val: "fast" },
        { desc: "boolean true", val: true },
        { desc: "empty object", val: {} },
        { desc: "array with number", val: [100] },
      ];

      test.each(badRateLimitTypes)(
        "rejects rate_limit type $desc with 400",
        async ({ val }) => {
          const res = await request(app)
            .post("/admin/api-keys")
            .set("Authorization", "Bearer admin-test-secret")
            .send({ consumer_name: "coercion-svc", rate_limit: val });

          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe("bad_request");
        },
      );

      const badGraceTypes = [
        { desc: "non-numeric string 'zero'", val: "zero" },
        { desc: "boolean true", val: true },
        { desc: "object", val: { grace: 100 } },
        { desc: "array", val: [5000] },
      ];

      test.each(badGraceTypes)(
        "rejects grace_period_ms type $desc with 400",
        async ({ val }) => {
          const key = generateApiKey("Grace-Type-Check");
          const res = await request(app)
            .post(`/admin/api-keys/${key.id}/rotate`)
            .set("Authorization", "Bearer admin-test-secret")
            .send({ grace_period_ms: val });

          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe("bad_request");
        },
      );
    });

    test("rejects completely empty JSON body with 400", async () => {
      const res = await request(app)
        .post("/admin/api-keys")
        .set("Authorization", "Bearer admin-test-secret")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    });
  });

  // =========================================================================
  // DIMENSION 4: NEGATIVE CONTROLS & SECURITY ISOLATION
  // =========================================================================
  describe("Dimension 4: Negative Controls & Security Isolation", () => {
    test("rejects missing Authorization header on create", async () => {
      const res = await request(app)
        .post("/admin/api-keys")
        .send({ consumer_name: "unauthed" });

      expect(res.status).toBe(401);
    });

    test("rejects wrong admin secret", async () => {
      const res = await request(app)
        .post("/admin/api-keys")
        .set("Authorization", "Bearer wrong-password")
        .send({ consumer_name: "unauthed" });

      expect(res.status).toBe(401);
    });

    test("rejects rotation of non-existent key id with 404", async () => {
      const res = await request(app)
        .post("/admin/api-keys/00000000-0000-0000-0000-000000000000/rotate")
        .set("Authorization", "Bearer admin-test-secret")
        .send({ grace_period_ms: 1000 });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    test("rejects rotation of revoked key with 404", async () => {
      const key = generateApiKey("Revoked-Target");
      const delRes = await request(app)
        .delete(`/admin/api-keys/${key.id}`)
        .set("Authorization", "Bearer admin-test-secret");
      expect(delRes.status).toBe(200);

      const rotRes = await request(app)
        .post(`/admin/api-keys/${key.id}/rotate`)
        .set("Authorization", "Bearer admin-test-secret")
        .send({ grace_period_ms: 1000 });

      expect(rotRes.status).toBe(404);
      expect(rotRes.body.error).toBe("not_found");
    });

    test("rejects usage query for non-existent key with 404", async () => {
      const res = await request(app)
        .get("/admin/api-keys/non-existent-key-id/usage")
        .set("Authorization", "Bearer admin-test-secret");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    test("rejects revoke of non-existent key with 404", async () => {
      const res = await request(app)
        .delete("/admin/api-keys/non-existent-key-id")
        .set("Authorization", "Bearer admin-test-secret");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    test("failed rotation with bad input leaves existing key completely unaffected", async () => {
      const key = generateApiKey("Isolated-Target", 150, 45);
      const originalKeyToken = key.key;

      const res = await request(app)
        .post(`/admin/api-keys/${key.id}/rotate`)
        .set("Authorization", "Bearer admin-test-secret")
        .send({ grace_period_ms: -500 });

      expect(res.status).toBe(400);

      // Verify key was not mutated
      const details = getApiKeyDetails(key.id);
      expect(details).not.toBeNull();
      expect(details?.key).toBe(originalKeyToken);
      expect(details?.last_rotated_at).toBeUndefined();
      expect(validateApiKey(originalKeyToken)).not.toBeNull();
    });

    test("rotating one key has zero side effects on sibling keys in store", async () => {
      const keyA = generateApiKey("Sibling-A", 100);
      const keyB = generateApiKey("Sibling-B", 200);
      const keyC = generateApiKey("Sibling-C", 300);

      const res = await request(app)
        .post(`/admin/api-keys/${keyB.id}/rotate`)
        .set("Authorization", "Bearer admin-test-secret")
        .send({ grace_period_ms: 5000 });

      expect(res.status).toBe(200);

      // Key A and C must be intact
      const detailsA = getApiKeyDetails(keyA.id);
      const detailsC = getApiKeyDetails(keyC.id);
      expect(detailsA?.key).toBe(keyA.key);
      expect(detailsA?.status).toBe("active");
      expect(detailsC?.key).toBe(keyC.key);
      expect(detailsC?.status).toBe("active");
      expect(validateApiKey(keyA.key)).not.toBeNull();
      expect(validateApiKey(keyC.key)).not.toBeNull();
    });
  });

  // =========================================================================
  // DIMENSION 5: LIFECYCLE, STATE INVARIANTS & STRESS
  // =========================================================================
  describe("Dimension 5: Lifecycle, State Invariants & Stress", () => {
    test("grace_period_ms: 0 immediately revokes old key upon rotation", async () => {
      const key = generateApiKey("Immediate-Retire", 50);
      const oldToken = key.key;

      expect(validateApiKey(oldToken)).not.toBeNull();

      const res = await request(app)
        .post(`/admin/api-keys/${key.id}/rotate`)
        .set("Authorization", "Bearer admin-test-secret")
        .send({ grace_period_ms: 0 });

      expect(res.status).toBe(200);
      const newToken = res.body.key;
      expect(newToken).toBeDefined();
      expect(newToken).not.toBe(oldToken);

      // Crucial: Old token must be rejected immediately
      expect(validateApiKey(oldToken)).toBeNull();
      // New token must be active and valid
      expect(validateApiKey(newToken)).not.toBeNull();
    });

    test("sequential rotation: grace 10s then grace 0s completely purges prior keys", async () => {
      const key = generateApiKey("Multi-Step-Retire");
      const token1 = key.key;

      // Rotation 1 with 10s grace
      const rot1 = await request(app)
        .post(`/admin/api-keys/${key.id}/rotate`)
        .set("Authorization", "Bearer admin-test-secret")
        .send({ grace_period_ms: 10000 });
      expect(rot1.status).toBe(200);
      const token2 = rot1.body.key;

      // Both token1 and token2 are valid during grace
      expect(validateApiKey(token1)).not.toBeNull();
      expect(validateApiKey(token2)).not.toBeNull();

      // Rotation 2 with 0ms grace
      const rot2 = await request(app)
        .post(`/admin/api-keys/${key.id}/rotate`)
        .set("Authorization", "Bearer admin-test-secret")
        .send({ grace_period_ms: 0 });
      expect(rot2.status).toBe(200);
      const token3 = rot2.body.key;

      // token1 and token2 must both be invalid now
      expect(validateApiKey(token1)).toBeNull();
      expect(validateApiKey(token2)).toBeNull();
      // Only token3 is valid
      expect(validateApiKey(token3)).not.toBeNull();
    });

    test("stress: generate 25 keys concurrently with random boundary parameters", async () => {
      const batchPromises = Array.from({ length: 25 }, (_, i) => {
        const rate = (i + 1) * 1000;
        const interval = (i % 30) + 1;
        return request(app)
          .post("/admin/api-keys")
          .set("Authorization", "Bearer admin-test-secret")
          .send({
            consumer_name: `stress-consumer-${i}`,
            rate_limit: rate,
            rotation_interval_days: interval,
          });
      });

      const responses = await Promise.all(batchPromises);
      const ids = new Set<string>();
      const keys = new Set<string>();

      responses.forEach((res, i) => {
        expect(res.status).toBe(201);
        expect(res.body.consumer_name).toBe(`stress-consumer-${i}`);
        ids.add(res.body.id);
        keys.add(res.body.key);
      });

      // Verify all 25 ids and keys are cryptographically distinct
      expect(ids.size).toBe(25);
      expect(keys.size).toBe(25);
    });

    test("stress: 10 rapid successive rotations on single key maintain invariants", async () => {
      const key = generateApiKey("Rapid-Rotator", 100);
      let currentKeyToken = key.key;
      let lastRotatedAt = 0;

      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post(`/admin/api-keys/${key.id}/rotate`)
          .set("Authorization", "Bearer admin-test-secret")
          .send({ grace_period_ms: 5000 });

        expect(res.status).toBe(200);
        expect(res.body.key).not.toBe(currentKeyToken);
        expect(res.body.last_rotated_at).toBeGreaterThanOrEqual(lastRotatedAt);

        currentKeyToken = res.body.key;
        lastRotatedAt = res.body.last_rotated_at;
      }

      // Latest key must validate
      expect(validateApiKey(currentKeyToken)).not.toBeNull();
    });
  });
});
