import { config, validateRequiredEnv, initEnv } from "../config";
import { initEnv as initLibEnv } from "../lib/env";

describe("Environment Config Module (Issue #272)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("validateRequiredEnv & initEnv", () => {
    it("valid config -> loads successfully when required env vars are present", () => {
      process.env.ADMIN_SECRET_KEY = "test-secret-key";
      process.env.PROJECT_REGISTRY_CONTRACT_ID = "C1234567890";

      expect(() => validateRequiredEnv()).not.toThrow();
      const env = initEnv();
      expect(env).toBeDefined();
      expect(env.ADMIN_SECRET_KEY).toBe("test-secret-key");
      expect(env.PROJECT_REGISTRY_CONTRACT_ID).toBe("C1234567890");
    });

    it("missing ADMIN_SECRET_KEY -> throws clear error message", () => {
      delete process.env.ADMIN_SECRET_KEY;
      process.env.PROJECT_REGISTRY_CONTRACT_ID = "C1234567890";

      expect(() => validateRequiredEnv()).toThrow(
        /Missing required environment variable: ADMIN_SECRET_KEY/,
      );
    });

    it("missing PROJECT_REGISTRY_CONTRACT_ID -> throws clear error message", () => {
      process.env.ADMIN_SECRET_KEY = "test-secret-key";
      delete process.env.PROJECT_REGISTRY_CONTRACT_ID;

      expect(() => validateRequiredEnv()).toThrow(
        /Missing required environment variable: PROJECT_REGISTRY_CONTRACT_ID/,
      );
    });

    it("invalid STELLAR_NETWORK -> throws an actionable error message", () => {
      process.env.ADMIN_SECRET_KEY = "test-secret-key";
      process.env.PROJECT_REGISTRY_CONTRACT_ID = "C1234567890";
      process.env.STELLAR_NETWORK = "invalid-network";

      expect(() => validateRequiredEnv()).toThrow(/STELLAR_NETWORK/);
      expect(() => validateRequiredEnv()).toThrow(/testnet|mainnet/);
    });
  });

  describe("Optional environment variable defaults", () => {
    it("provides fallback defaults for optional configuration fields", () => {
      delete process.env.STELLAR_NETWORK;
      delete process.env.RPC_URL;
      delete process.env.PORT;
      delete process.env.FRONTEND_URL;

      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const freshConfig = require("../config").config as typeof config;

      expect(freshConfig.STELLAR_NETWORK).toBe("testnet");
      expect(freshConfig.RPC_URL).toBe("https://soroban-testnet.stellar.org");
      expect(freshConfig.PORT).toBe(3001);
      expect(freshConfig.FRONTEND_URL).toBe("http://localhost:3000");
    });

    it("lib/env initEnv returns default port and frontend url", () => {
      const libEnv = initLibEnv();
      expect(libEnv.PORT).toBeDefined();
      expect(libEnv.FRONTEND_URL).toBeDefined();
    });
  });
});
