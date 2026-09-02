import type { IncomingMessage } from "http";
import { authenticate } from "../lib/websocket";

function req(opts: { url?: string; authorization?: string }): IncomingMessage {
  return {
    url: opts.url ?? "/ws",
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  } as unknown as IncomingMessage;
}

describe("websocket authenticate()", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.WS_AUTH_TOKEN;
    delete process.env.ADMIN_API_KEY;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("accepts a matching Bearer token", () => {
    process.env.WS_AUTH_TOKEN = "ws-secret";
    expect(authenticate(req({ authorization: "Bearer ws-secret" }))).toBe(true);
  });

  it("rejects a wrong Bearer token", () => {
    process.env.WS_AUTH_TOKEN = "ws-secret";
    expect(authenticate(req({ authorization: "Bearer nope" }))).toBe(false);
  });

  it("ignores the ?token= query parameter entirely", () => {
    process.env.WS_AUTH_TOKEN = "ws-secret";
    expect(authenticate(req({ url: "/ws?token=ws-secret" }))).toBe(false);
  });

  it("never falls back to ADMIN_API_KEY", () => {
    process.env.ADMIN_API_KEY = "admin-key";
    process.env.NODE_ENV = "production";
    expect(authenticate(req({ authorization: "Bearer admin-key" }))).toBe(false);
  });

  it("fails closed in production when WS_AUTH_TOKEN is unset", () => {
    process.env.NODE_ENV = "production";
    expect(authenticate(req({}))).toBe(false);
  });

  it("skips auth outside production when WS_AUTH_TOKEN is unset", () => {
    process.env.NODE_ENV = "development";
    expect(authenticate(req({}))).toBe(true);
  });
});
