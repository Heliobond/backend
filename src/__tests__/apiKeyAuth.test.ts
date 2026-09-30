import express from "express";
import request from "supertest";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/apiKeyAuth";
import * as apiKeys from "../lib/apiKeys";

jest.mock("../lib/apiKeys");

describe("apiKeyAuth middleware", () => {
  let app: express.Express;
  const mockResolveAuthContext = apiKeys.resolveAuthContext as jest.MockedFunction<
    typeof apiKeys.resolveAuthContext
  >;
  const mockIncrementUsage = apiKeys.incrementUsage as jest.MockedFunction<
    typeof apiKeys.incrementUsage
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use(apiKeyAuth);
    app.get("/test", (req: AuthenticatedRequest, res) => {
      res.json({
        success: true,
        apiKeyInfo: req.apiKeyInfo,
      });
    });
  });

  describe("Happy path - valid authentication", () => {
    it("should allow request with valid API key and increment usage", async () => {
      mockResolveAuthContext.mockReturnValue({
        providedKey: "valid-key",
        isAdmin: false,
        isConsumer: true,
        consumerName: "test-consumer",
        keyRecord: {
          id: "key-123",
          key: "valid-key",
          consumer_name: "test-consumer",
          status: "active",
          rate_limit: 100,
          usage_count: 0,
          last_used_at: null,
          created_at: Date.now(),
        },
        rateLimited: false,
      });

      const res = await request(app).get("/test").set("X-API-Key", "valid-key");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.apiKeyInfo).toEqual({
        id: "key-123",
        consumer_name: "test-consumer",
        rate_limit: 100,
      });
      expect(mockIncrementUsage).toHaveBeenCalledWith("key-123");
    });

    it("should allow request with admin bearer token", async () => {
      mockResolveAuthContext.mockReturnValue({
        providedKey: "admin-key",
        isAdmin: true,
        isConsumer: false,
        consumerName: "",
        keyRecord: null,
        rateLimited: false,
      });

      const res = await request(app).get("/test").set("Authorization", "Bearer admin-key");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockIncrementUsage).not.toHaveBeenCalled();
    });

    it("should allow request with valid bearer token format", async () => {
      mockResolveAuthContext.mockReturnValue({
        providedKey: "bearer-key",
        isAdmin: false,
        isConsumer: true,
        consumerName: "bearer-consumer",
        keyRecord: {
          id: "key-456",
          key: "bearer-key",
          consumer_name: "bearer-consumer",
          status: "active",
          rate_limit: 50,
          usage_count: 10,
          last_used_at: Date.now(),
          created_at: Date.now(),
        },
        rateLimited: false,
      });

      const res = await request(app).get("/test").set("Authorization", "Bearer bearer-key");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockIncrementUsage).toHaveBeenCalledWith("key-456");
    });
  });

  describe("Error path - missing API key", () => {
    it("should return 401 when no API key is provided", async () => {
      mockResolveAuthContext.mockReturnValue({
        providedKey: "",
        isAdmin: false,
        isConsumer: false,
        consumerName: "",
        keyRecord: null,
        rateLimited: false,
      });

      const res = await request(app).get("/test");

      expect(res.status).toBe(401);
      expect(res.body.error).toEqual({
        code: "unauthorized",
        message: "Missing API key in Authorization bearer token or X-API-Key header",
      });
      expect(mockIncrementUsage).not.toHaveBeenCalled();
    });
  });

  describe("Error path - invalid API key", () => {
    it("should return 401 when API key is invalid", async () => {
      mockResolveAuthContext.mockReturnValue({
        providedKey: "invalid-key",
        isAdmin: false,
        isConsumer: false,
        consumerName: "",
        keyRecord: null,
        rateLimited: false,
      });

      const res = await request(app).get("/test").set("X-API-Key", "invalid-key");

      expect(res.status).toBe(401);
      expect(res.body.error).toEqual({
        code: "unauthorized",
        message: "Invalid or revoked API key",
      });
      expect(mockIncrementUsage).not.toHaveBeenCalled();
    });

    it("should return 401 when API key is revoked", async () => {
      mockResolveAuthContext.mockReturnValue({
        providedKey: "revoked-key",
        isAdmin: false,
        isConsumer: false,
        consumerName: "",
        keyRecord: null,
        rateLimited: false,
      });

      const res = await request(app).get("/test").set("Authorization", "Bearer revoked-key");

      expect(res.status).toBe(401);
      expect(res.body.error).toEqual({
        code: "unauthorized",
        message: "Invalid or revoked API key",
      });
      expect(mockIncrementUsage).not.toHaveBeenCalled();
    });
  });

  describe("Error path - rate limiting", () => {
    it("should return 429 when rate limit is exceeded", async () => {
      mockResolveAuthContext.mockReturnValue({
        providedKey: "rate-limited-key",
        isAdmin: false,
        isConsumer: false,
        consumerName: "",
        keyRecord: {
          id: "key-789",
          key: "rate-limited-key",
          consumer_name: "limited-consumer",
          status: "active",
          rate_limit: 10,
          usage_count: 1000,
          last_used_at: Date.now(),
          created_at: Date.now(),
        },
        rateLimited: true,
      });

      const res = await request(app).get("/test").set("X-API-Key", "rate-limited-key");

      expect(res.status).toBe(429);
      expect(res.body.error).toEqual({
        code: "too_many_requests",
        message: "Rate limit exceeded for this API key. Please retry later.",
      });
      expect(mockIncrementUsage).not.toHaveBeenCalled();
    });
  });
});
