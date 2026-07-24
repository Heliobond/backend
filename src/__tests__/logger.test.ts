import { logger, setLogLevel, getLogLevel, getLogLevels } from "../lib/logger";

describe("logger configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NODE_ENV = "development";
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getLogLevel", () => {
    it("returns debug for development environment", () => {
      process.env.NODE_ENV = "development";
      expect(getLogLevel()).toBe("debug");
    });

    it("returns info for staging environment", () => {
      process.env.NODE_ENV = "staging";
      expect(getLogLevel()).toBe("info");
    });

    it("returns warn for production environment", () => {
      process.env.NODE_ENV = "production";
      expect(getLogLevel()).toBe("warn");
    });

    it("returns LOG_LEVEL when explicitly set", () => {
      process.env.LOG_LEVEL = "error";
      expect(getLogLevel()).toBe("error");
    });

    it("defaults to info for unknown environment", () => {
      process.env.NODE_ENV = "unknown";
      expect(getLogLevel()).toBe("info");
    });
  });

  describe("setLogLevel", () => {
    it("allows changing log level at runtime", () => {
      setLogLevel("error");
      expect(getLogLevel()).toBe("error");
    });

    it("throws for invalid log level", () => {
      expect(() => setLogLevel("invalid" as any)).toThrow("Invalid log level");
    });
  });

  describe("getLogLevels", () => {
    it("returns all available log levels", () => {
      const levels = getLogLevels();
      expect(levels).toEqual({
        debug: 0,
        info: 1,
        warn: 2,
        error: 3,
      });
    });
  });
});
