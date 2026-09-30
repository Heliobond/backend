import request from "supertest";
import express, { Express } from "express";
import { createTelemetryRouter } from "../routes/telemetry";
import { createRateLimiter } from "../middleware/rateLimit";
import { csrfProtection, resetCsrfStore } from "../middleware/csrf";
import { register } from "../lib/prometheus";
import { config } from "../config";
import {
  classifyTelemetryReport,
  isErrorReport,
  isWebVitalReport,
  parseByteSize,
  redactPiiString,
  scrubPii,
} from "../lib/telemetry";

// A syntactically valid-looking Stellar ed25519 address (G + 55 base32 chars).
const STELLAR_ADDRESS = "G" + "A".repeat(55);
const EMAIL = "victim@example.com";
// Long base64 blob resembling a serialized XDR transaction envelope.
const XDR_BLOB = "A".repeat(160);

function buildApp(limiter?: Parameters<typeof createTelemetryRouter>[0]): Express {
  const app = express();
  // Mirrors src/index.ts: global JSON body parsing runs before the router.
  app.use(express.json({ limit: config.BODY_SIZE_LIMIT }));
  app.use(csrfProtection);
  app.use("/v1/telemetry", createTelemetryRouter(limiter));
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });
  app.post("/v1/other", (_req, res) => res.json({ ok: true }));
  return app;
}

async function metricsText(app: Express): Promise<string> {
  const res = await request(app).get("/metrics").expect(200);
  return res.text;
}

describe("POST /v1/telemetry (#770)", () => {
  let app: Express;

  beforeEach(() => {
    resetCsrfStore();
    register.resetMetrics();
    app = buildApp();
  });

  describe("acceptance and status codes", () => {
    it("accepts a text/plain beacon (navigator.sendBeacon) with 204", async () => {
      const res = await request(app)
        .post("/v1/telemetry")
        .set("Content-Type", "text/plain;charset=UTF-8")
        .send(JSON.stringify({ kind: "runtime", message: "boom" }));

      expect(res.status).toBe(204);
      expect(res.text).toBe("");
    });

    it("accepts an application/json error report with 204", async () => {
      const res = await request(app)
        .post("/v1/telemetry")
        .send({ kind: "unhandledrejection", message: "failed", contractErrorName: "InvalidScore" });

      expect(res.status).toBe(204);
    });

    it("returns 400 for a payload that matches neither schema", async () => {
      const res = await request(app).post("/v1/telemetry").send({ foo: "bar" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_telemetry");
    });

    it("returns 400 for malformed text/plain JSON", async () => {
      const res = await request(app)
        .post("/v1/telemetry")
        .set("Content-Type", "text/plain")
        .send("{not json");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_telemetry");
    });

    it("returns 413 for a text/plain body over the size limit", async () => {
      const oversized = JSON.stringify({ kind: "runtime", message: "x".repeat(70 * 1024) });
      const res = await request(app)
        .post("/v1/telemetry")
        .set("Content-Type", "text/plain")
        .send(oversized);

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe("payload_too_large");
    });

    it("is exempt from CSRF while other POSTs still require a token", async () => {
      await request(app)
        .post("/v1/telemetry")
        .send({ kind: "runtime", message: "boom" })
        .expect(204);

      const blocked = await request(app).post("/v1/other").send({});
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe("csrf_token_missing");
    });
  });

  describe("Prometheus instrumentation", () => {
    it("reflects an accepted error beacon in /metrics", async () => {
      await request(app)
        .post("/v1/telemetry")
        .set("Content-Type", "text/plain")
        .send(
          JSON.stringify({ kind: "runtime", message: "boom", contractErrorName: "InvalidScore" }),
        )
        .expect(204);

      const text = await metricsText(app);
      expect(text).toContain("frontend_errors_total");
      expect(text).toContain('kind="runtime"');
      expect(text).toContain('contract_error_name="InvalidScore"');
    });

    it('uses contract_error_name="none" when no contract error is present', async () => {
      await request(app)
        .post("/v1/telemetry")
        .send({ kind: "react", message: "render failed" })
        .expect(204);

      const text = await metricsText(app);
      expect(text).toContain('contract_error_name="none"');
    });

    it("records a Web Vital histogram by name and rating", async () => {
      await request(app)
        .post("/v1/telemetry")
        .send({ name: "LCP", value: 2345, rating: "good" })
        .expect(204);

      const text = await metricsText(app);
      expect(text).toContain("frontend_web_vital_bucket");
      expect(text).toContain('name="LCP"');
      expect(text).toContain('rating="good"');
    });
  });

  describe("rate limiting per IP", () => {
    it("returns 429 once the per-IP limit is exceeded", async () => {
      const limited = buildApp(createRateLimiter(60_000, 1));
      await request(limited)
        .post("/v1/telemetry")
        .send({ kind: "runtime", message: "boom" })
        .expect(204);

      const res = await request(limited)
        .post("/v1/telemetry")
        .send({ kind: "runtime", message: "boom" });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("too_many_requests");
      expect(res.headers["retry-after"]).toBeDefined();
    });
  });

  describe("PII scrub", () => {
    it("redacts Stellar addresses, e-mail addresses, and XDR blobs", () => {
      const scrubbed = redactPiiString(`owner ${STELLAR_ADDRESS} mail ${EMAIL} xdr ${XDR_BLOB}`);
      expect(scrubbed).not.toContain(STELLAR_ADDRESS);
      expect(scrubbed).not.toContain(EMAIL);
      expect(scrubbed).not.toContain(XDR_BLOB);
      expect(scrubbed).toContain("[redacted:stellar-address]");
      expect(scrubbed).toContain("[redacted:email]");
      expect(scrubbed).toContain("[redacted:xdr]");
    });

    it("scrubs nested payload strings recursively", () => {
      const scrubbed = scrubPii({
        kind: "runtime",
        message: `failed for ${EMAIL}`,
        nested: { stack: `at ${STELLAR_ADDRESS}` },
      }) as { message: string; nested: { stack: string } };

      expect(scrubbed.message).not.toContain(EMAIL);
      expect(scrubbed.nested.stack).not.toContain(STELLAR_ADDRESS);
    });

    it("accepts a PII-laden beacon but never exports the PII in /metrics", async () => {
      const res = await request(app)
        .post("/v1/telemetry")
        .set("Content-Type", "text/plain")
        .send(
          JSON.stringify({
            kind: "contract",
            message: `tx to ${STELLAR_ADDRESS} failed, contact ${EMAIL}`,
            stack: `HostError at ${XDR_BLOB}`,
          }),
        );

      expect(res.status).toBe(204);

      const text = await metricsText(app);
      expect(text).not.toContain(STELLAR_ADDRESS);
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain(XDR_BLOB);
    });

    it("rejects a PII value (redacted) supplied as a metric label", async () => {
      const res = await request(app)
        .post("/v1/telemetry")
        .send({ kind: "runtime", message: "boom", contractErrorName: STELLAR_ADDRESS });

      expect(res.status).toBe(400);
    });
  });
});

describe("telemetry helpers (#770)", () => {
  describe("parseByteSize", () => {
    it("parses kb, mb, b and bare numbers", () => {
      expect(parseByteSize("64kb")).toBe(64 * 1024);
      expect(parseByteSize("1mb")).toBe(1024 * 1024);
      expect(parseByteSize("512b")).toBe(512);
      expect(parseByteSize("100")).toBe(100);
    });

    it("falls back to 64 KiB for unparseable values", () => {
      expect(parseByteSize("not-a-size")).toBe(64 * 1024);
    });
  });

  describe("schema guards", () => {
    it("accepts a minimal ErrorReport", () => {
      expect(isErrorReport({ kind: "runtime", message: "boom" })).toBe(true);
    });

    it("rejects an ErrorReport missing kind or message", () => {
      expect(isErrorReport({ message: "boom" })).toBe(false);
      expect(isErrorReport({ kind: "runtime" })).toBe(false);
      expect(isErrorReport({ kind: "runtime", message: "" })).toBe(false);
    });

    it("accepts a WebVitalReport and rejects unknown names/ratings", () => {
      expect(isWebVitalReport({ name: "CLS", value: 0.1, rating: "good" })).toBe(true);
      expect(isWebVitalReport({ name: "NOPE", value: 1, rating: "good" })).toBe(false);
      expect(isWebVitalReport({ name: "LCP", value: 1, rating: "great" })).toBe(false);
      expect(isWebVitalReport({ name: "LCP", value: -1, rating: "good" })).toBe(false);
    });

    it("classifies errors before web vitals", () => {
      expect(classifyTelemetryReport({ kind: "runtime", message: "boom" })?.type).toBe("error");
      expect(classifyTelemetryReport({ name: "INP", value: 200, rating: "good" })?.type).toBe(
        "web-vital",
      );
      expect(classifyTelemetryReport({ hello: "world" })).toBeNull();
    });
  });
});
