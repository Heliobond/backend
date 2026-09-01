import { resolveAuthFromHeaders } from "../lib/authHelper";
import * as apiKeys from "../lib/apiKeys";

describe("authHelper", () => {
  beforeEach(() => {
    apiKeys.clearApiKeys();
    delete process.env.ADMIN_API_KEY;
  });

  afterEach(() => {
    apiKeys.clearApiKeys();
  });

  it("should return missing error when no keys are provided", () => {
    const result = resolveAuthFromHeaders({});
    expect(result.error).toBe("missing");
    expect(result.isAdmin).toBe(false);
    expect(result.isConsumer).toBe(false);
  });

  it("should authenticate admin with x-api-key", () => {
    process.env.ADMIN_API_KEY = "admin123";
    const result = resolveAuthFromHeaders({ "x-api-key": "admin123" });
    expect(result.isAdmin).toBe(true);
    expect(result.isConsumer).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("should authenticate admin with Bearer token", () => {
    process.env.ADMIN_API_KEY = "admin123";
    const result = resolveAuthFromHeaders({ authorization: "Bearer admin123" });
    expect(result.isAdmin).toBe(true);
    expect(result.isConsumer).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("should authenticate consumer with valid key", () => {
    const apiKey = apiKeys.generateApiKey("test-consumer", 100);
    const result = resolveAuthFromHeaders({ "x-api-key": apiKey.key });
    expect(result.isAdmin).toBe(false);
    expect(result.isConsumer).toBe(true);
    expect(result.consumerName).toBe("test-consumer");
    expect(result.error).toBeUndefined();
  });

  it("should return invalid error for incorrect consumer key", () => {
    const result = resolveAuthFromHeaders({ "x-api-key": "bad-key" });
    expect(result.error).toBe("invalid");
    expect(result.isAdmin).toBe(false);
    expect(result.isConsumer).toBe(false);
  });

  it("should return rate_limited error when consumer exceeds limit", () => {
    const apiKey = apiKeys.generateApiKey("test-consumer", 1);
    // first request succeeds
    resolveAuthFromHeaders({ "x-api-key": apiKey.key });
    // second fails
    const result = resolveAuthFromHeaders({ "x-api-key": apiKey.key });
    expect(result.error).toBe("rate_limited");
    expect(result.isConsumer).toBe(false);
  });
});
