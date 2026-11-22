import { logger, setLogLevel, getLogLevel, getLogLevels, clearLogLevelCache } from "../lib/logger";

describe("logger configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NODE_ENV = "development";
    delete process.env.LOG_LEVEL;
    clearLogLevelCache();
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

  describe("level caching", () => {
    it("reads the environment once until the cache is cleared", () => {
      process.env.LOG_LEVEL = "error";
      expect(getLogLevel()).toBe("error");
      process.env.LOG_LEVEL = "debug";
      expect(getLogLevel()).toBe("error");
      clearLogLevelCache();
      expect(getLogLevel()).toBe("debug");
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

  describe("formatError", () => {
    it("formats standard errors with error_name and error_message", () => {
      const err = new Error("something went wrong");
      const formatted = logger.formatError(err);
      expect(formatted).toMatchObject({
        error_name: "Error",
        error_message: "something went wrong",
      });
      expect(formatted.contract_error_name).toBeUndefined();
    });

    it("formats non-error values into error string", () => {
      expect(logger.formatError("simple error string")).toEqual({
        error: "simple error string",
      });
    });

    it("decodes contract errors into contract_error_name, contract_error_code, contract_error_source", () => {
      const err = new Error("simulation failed: HostError: Error(Contract, #7)");
      const formatted = logger.formatError(err);
      expect(formatted).toMatchObject({
        error_name: "Error",
        error_message: "simulation failed: HostError: Error(Contract, #7)",
        contract_error_name: "ProjectNotFound",
        contract_error_code: 7,
        contract_error_source: "registry",
      });
    });

    it("decodes contract errors from plain string errors", () => {
      const formatted = logger.formatError("HostError: Error(Contract, #2)");
      expect(formatted).toMatchObject({
        error: "HostError: Error(Contract, #2)",
        contract_error_name: "UpdateTooFrequent",
        contract_error_code: 2,
        contract_error_source: "registry",
      });
    });

    it("decodes unknown contract errors with Unknown name while preserving code", () => {
      const formatted = logger.formatError(new Error("HostError: Error(Contract, #999)"));
      expect(formatted).toMatchObject({
        contract_error_name: "Unknown",
        contract_error_code: 999,
        contract_error_source: "registry",
      });
    });
  });
});
