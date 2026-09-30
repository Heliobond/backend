import request from "supertest";
import express, { Express } from "express";
import emailRouter, { publicEmailRouter } from "../routes/email";
import { errorHandler } from "../middleware/errors";
import {
  subscribe,
  clearSubscribers,
  buildUnsubscribeToken,
  buildUnsubscribeUrl,
  buildListUnsubscribeHeaders,
  sendAlertIfSignificant,
  sendDigest,
  setThresholds,
} from "../lib/email";

// Public-router coverage for #763.
//
// The three axes exercised here mirror the issue's acceptance criteria:
//   1. Email footers carry an absolute HTTPS URL (not `/v1/...`) and the
//      accompanying `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
//   2. `GET /v1/email/unsubscribe` and `POST /v1/email/unsubscribe` both
//      succeed without any admin credential (no IP allowlist, no HMAC
//      signature, no bearer).
//   3. The stored unsubscribe token is not a raw UUID; it is an HMAC
//      derived from the subscriber's email, so leaking the in-memory map
//      does not reveal a link that can be replayed after rotating the
//      unsubscribe secret.

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Same order as production: public router first so `/unsubscribe`
  // matches without admin middleware.
  app.use("/v1/email", publicEmailRouter);
  app.use("/v1/email", emailRouter);
  app.use(errorHandler);
  return app;
}

describe("public email unsubscribe (#763)", () => {
  const originalEnv = { ...process.env };
  let app: Express;

  beforeEach(() => {
    clearSubscribers();
    app = buildApp();
    process.env.PUBLIC_API_URL = "https://api.heliobond.test";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("GET /v1/email/unsubscribe works without admin headers", async () => {
    const sub = subscribe("alice@example.com", "weekly");
    await request(app)
      .get(`/v1/email/unsubscribe?token=${encodeURIComponent(sub.unsubscribe_token)}`)
      .expect(200)
      .expect({ unsubscribed: true });
  });

  it("POST /v1/email/unsubscribe (RFC 8058 One-Click) works without admin headers", async () => {
    const sub = subscribe("bob@example.com", "daily");
    await request(app)
      .post("/v1/email/unsubscribe")
      .send({ token: sub.unsubscribe_token })
      .expect(200)
      .expect({ unsubscribed: true });
  });

  it("returns 404 for an unknown or already-used token", async () => {
    await request(app).get("/v1/email/unsubscribe?token=deadbeef").expect(404);
  });

  it("returns 400 when the token is missing", async () => {
    await request(app).get("/v1/email/unsubscribe").expect(400);
    await request(app).post("/v1/email/unsubscribe").send({}).expect(400);
  });

  it("does not accept raw UUID tokens even if they happen to match a subscriber's stored value", async () => {
    // The stored value IS an HMAC now, so any random UUID string should
    // fail verification even if it collides with something structurally
    // similar.
    subscribe("carol@example.com", "weekly");
    await request(app)
      .get("/v1/email/unsubscribe?token=00000000-0000-0000-0000-000000000000")
      .expect(404);
  });
});

describe("unsubscribe token derivation (#763)", () => {
  const originalSecret = process.env.EMAIL_UNSUBSCRIBE_SECRET;

  beforeEach(() => {
    clearSubscribers();
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret-fixed";
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    else process.env.EMAIL_UNSUBSCRIBE_SECRET = originalSecret;
  });

  it("token is a base64url HMAC, not a raw UUID", () => {
    const token = buildUnsubscribeToken("alice@example.com");
    // No hyphens (UUIDs have four); base64url character set only.
    expect(token).not.toMatch(/-/);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(30);
  });

  it("is deterministic per email + secret", () => {
    const a = buildUnsubscribeToken("alice@example.com");
    const b = buildUnsubscribeToken("alice@example.com");
    expect(a).toEqual(b);
  });

  it("is case-normalized on the email input", () => {
    const lower = buildUnsubscribeToken("alice@example.com");
    const mixed = buildUnsubscribeToken("Alice@Example.COM");
    expect(mixed).toEqual(lower);
  });

  it("changes when the secret rotates", () => {
    const before = buildUnsubscribeToken("alice@example.com");
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "rotated-secret";
    const after = buildUnsubscribeToken("alice@example.com");
    expect(after).not.toEqual(before);
  });
});

describe("absolute unsubscribe URL + List-Unsubscribe headers (#763)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearSubscribers();
    process.env.PUBLIC_API_URL = "https://api.heliobond.test";
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret-fixed";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("buildUnsubscribeUrl is absolute HTTPS and contains the token", () => {
    const url = buildUnsubscribeUrl("some-token");
    expect(url.startsWith("https://api.heliobond.test/v1/email/unsubscribe?token=")).toBe(true);
    expect(url).toContain("some-token");
  });

  it("buildListUnsubscribeHeaders returns the RFC 8058 pair", () => {
    const headers = buildListUnsubscribeHeaders("some-token");
    expect(headers["List-Unsubscribe"]).toMatch(
      /^<https:\/\/api\.heliobond\.test\/v1\/email\/unsubscribe\?token=some-token>$/,
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  // Same-module `jest.spyOn(emailLib, "sendEmail")` does not intercept the
  // in-file call inside `sendAlertIfSignificant` / `sendDigest`, so drive
  // through the real SendGrid transport with a global fetch mock. That
  // also gives us the outgoing HTTP shape (including the `headers` field
  // sent to SendGrid), which is what mail clients ultimately receive.
  function captureSendGridPayloads(): {
    calls: Array<Record<string, unknown>>;
    restore: () => void;
  } {
    const calls: Array<Record<string, unknown>> = [];
    process.env.SENDGRID_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push(body);
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch;
    return {
      calls,
      restore: () => {
        globalThis.fetch = originalFetch;
        delete process.env.SENDGRID_API_KEY;
      },
    };
  }

  it("alert emails carry an absolute Unsubscribe footer + List-Unsubscribe headers", async () => {
    const { calls, restore } = captureSendGridPayloads();
    try {
      subscribe("dan@example.com", "weekly");
      setThresholds({ credit_quality_delta: 1, green_impact_delta: 1 });
      const sent = await sendAlertIfSignificant({
        project_id: 42,
        credit_quality_delta: 10,
        green_impact_delta: 0,
      });
      expect(sent).toBe(1);
      expect(calls).toHaveLength(1);
      const payload = calls[0];
      const content = (payload.content as Array<{ value: string }>) ?? [];
      const headers = (payload.headers as Record<string, string>) ?? {};
      expect(content[0].value).toMatch(
        /\nUnsubscribe: https:\/\/api\.heliobond\.test\/v1\/email\/unsubscribe\?token=/,
      );
      expect(headers["List-Unsubscribe"]).toContain(
        "https://api.heliobond.test/v1/email/unsubscribe?token=",
      );
      expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    } finally {
      restore();
    }
  });

  it("digest emails carry an absolute Unsubscribe footer + List-Unsubscribe headers", async () => {
    const { calls, restore } = captureSendGridPayloads();
    try {
      subscribe("eve@example.com", "daily");
      const sent = await sendDigest("daily", [
        { project_id: 7, credit_quality_delta: 2, green_impact_delta: 3 },
      ]);
      expect(sent).toBe(1);
      expect(calls).toHaveLength(1);
      const payload = calls[0];
      const content = (payload.content as Array<{ value: string }>) ?? [];
      const headers = (payload.headers as Record<string, string>) ?? {};
      expect(content[0].value).toMatch(
        /\nUnsubscribe: https:\/\/api\.heliobond\.test\/v1\/email\/unsubscribe\?token=/,
      );
      expect(headers["List-Unsubscribe"]).toContain(
        "https://api.heliobond.test/v1/email/unsubscribe?token=",
      );
    } finally {
      restore();
    }
  });
});
