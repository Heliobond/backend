import { getSecret, getSecretWithFallback, getSecretsStatus } from "../lib/secrets";

describe("secrets management", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SECRETS_PROVIDER = "env";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getSecret", () => {
    it("returns environment variable when provider is env", async () => {
      process.env.TEST_SECRET = "test-value";
      const value = await getSecret("TEST_SECRET");
      expect(value).toBe("test-value");
    });

    it("returns undefined for non-existent secret", async () => {
      const value = await getSecret("NON_EXISTENT_SECRET_12345");
      expect(value).toBeUndefined();
    });

    it("caches secrets after first fetch", async () => {
      process.env.CACHED_SECRET = "cached-value";
      const value1 = await getSecret("CACHED_SECRET");
      const value2 = await getSecret("CACHED_SECRET");
      expect(value1).toBe("cached-value");
      expect(value2).toBe("cached-value");
    });
  });

  describe("getSecretWithFallback", () => {
    it("returns secret value when available", async () => {
      process.env.MY_SECRET = "secret-value";
      const value = await getSecretWithFallback("MY_SECRET", "FALLBACK_KEY");
      expect(value).toBe("secret-value");
    });

    it("falls back to environment variable when secret not available", async () => {
      process.env.FALLBACK_KEY = "fallback-value";
      const value = await getSecretWithFallback("NON_EXISTENT", "FALLBACK_KEY");
      expect(value).toBe("fallback-value");
    });
  });

  describe("getSecretsStatus", () => {
    it("returns current secrets status", () => {
      process.env.SECRETS_PROVIDER = "env";
      const status = getSecretsStatus();
      expect(status.provider).toBe("env");
      expect(Array.isArray(status.cachedKeys)).toBe(true);
      expect(typeof status.lastRotated).toBe("string");
      expect(typeof status.rotationEnabled).toBe("boolean");
    });
  });
});
