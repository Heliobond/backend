import { Request, Response, NextFunction } from "express";
import { createHmac } from "crypto";
import { requestSigning } from "../middleware/requestSigning";

describe("requestSigning middleware", () => {
  const originalEnv = process.env;
  const SECRET = "test-secret-key";

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.REQUEST_SIGNING_SECRET = SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createMockReq(overrides: Partial<Request> = {}): Request {
    return {
      headers: {},
      method: "POST",
      path: "/test",
      body: {},
      ...overrides,
    } as Request;
  }

  function createMockRes(): Response {
    const res = {} as Response;
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  function computeSignature(timestamp: string, method: string, path: string, body: string): string {
    const payload = `${timestamp}:${method}:${path}:${body}`;
    return createHmac("sha256", SECRET).update(payload).digest("hex");
  }

  it("should call next() when REQUEST_SIGNING_SECRET is not set", () => {
    delete process.env.REQUEST_SIGNING_SECRET;
    const req = createMockReq();
    const res = createMockRes();
    const next = jest.fn();

    requestSigning(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("should return 401 when signature header is missing", () => {
    const req = createMockReq({
      headers: { "x-timestamp": String(Date.now()) },
    });
    const res = createMockRes();
    const next = jest.fn();

    requestSigning(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing signature or timestamp header" });
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 when timestamp header is missing", () => {
    const req = createMockReq({
      headers: { "x-signature": "some-sig" },
    });
    const res = createMockRes();
    const next = jest.fn();

    requestSigning(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 when timestamp is expired", () => {
    const oldTimestamp = String(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const req = createMockReq({
      headers: {
        "x-timestamp": oldTimestamp,
        "x-signature": "some-sig",
      },
    });
    const res = createMockRes();
    const next = jest.fn();

    requestSigning(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Request timestamp expired or invalid" });
  });

  it("should return 401 when signature is invalid", () => {
    const timestamp = String(Date.now());
    const req = createMockReq({
      headers: {
        "x-timestamp": timestamp,
        "x-signature": "invalid-signature",
      },
      body: { data: "test" },
    });
    const res = createMockRes();
    const next = jest.fn();

    requestSigning(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid request signature" });
  });

  it("should call next() with valid signature", () => {
    const timestamp = String(Date.now());
    const body = JSON.stringify({ data: "test" });
    const signature = computeSignature(timestamp, "POST", "/test", body);

    const req = createMockReq({
      headers: {
        "x-timestamp": timestamp,
        "x-signature": signature,
      },
      body: { data: "test" },
    });
    const res = createMockRes();
    const next = jest.fn();

    requestSigning(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should handle string body correctly", () => {
    const timestamp = String(Date.now());
    const body = "raw string body";
    const signature = computeSignature(timestamp, "POST", "/test", body);

    const req = createMockReq({
      headers: {
        "x-timestamp": timestamp,
        "x-signature": signature,
      },
      body: body,
    } as any);
    const res = createMockRes();
    const next = jest.fn();

    requestSigning(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
