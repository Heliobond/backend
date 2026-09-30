import request from "supertest";
import express, { Request, Response } from "express";
import {
  versionHeaders,
  acceptVersion,
  deprecationHeaders,
  legacyApiUsage,
  legacyPathLabel,
  LEGACY_SUNSET_DATE,
} from "../middleware/versioning";
import { register } from "../lib/prometheus";

function buildApp() {
  const app = express();
  app.use(express.json());

  const v1 = express.Router();
  v1.use(versionHeaders);
  v1.use(acceptVersion);
  v1.get("/ping", (_req: Request, res: Response) => res.json({ ok: true }));
  app.use("/v1", v1);

  app.use("/api", deprecationHeaders, versionHeaders);
  app.get("/api/ping", (_req: Request, res: Response) => res.json({ ok: true }));
  app.get("/api/v1/ping", (_req: Request, res: Response) => res.json({ ok: true }));

  return app;
}

describe("API versioning middleware", () => {
  const app = buildApp();

  it("sets API-Version header on /v1 responses", async () => {
    const res = await request(app).get("/v1/ping");
    expect(res.status).toBe(200);
    expect(res.headers["api-version"]).toBe("1");
  });

  it("accepts a valid Accept-Version header", async () => {
    const res = await request(app).get("/v1/ping").set("Accept-Version", "1");
    expect(res.status).toBe(200);
  });

  it("rejects an unsupported Accept-Version header", async () => {
    const res = await request(app).get("/v1/ping").set("Accept-Version", "99");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported api version/i);
  });

  it("serves the v1 route at /api/v1 and sets the version headers", async () => {
    const res = await request(app).get("/api/v1/ping");
    expect(res.status).toBe(200);
    expect(res.headers["api-version"]).toBe("1");
    expect(res.body).toEqual({ ok: true });
  });

  it("keeps legacy /api routes working and adds deprecation headers", async () => {
    const res = await request(app).get("/api/ping");
    expect(res.status).toBe(200);
    expect(res.headers["deprecation"]).toBe("true");
    expect(res.headers["sunset"]).toBeDefined();
    expect(res.headers["link"]).toContain("/v1");
  });
});

describe("requestLogger correlation ID", () => {
  it("echoes X-Correlation-Id from the request", async () => {
    const { requestLogger } = await import("../middleware/requestLogger");
    const app = express();
    app.use(requestLogger);
    app.get("/test", (_req: Request, res: Response) => {
      res.set("X-Correlation-Id", _req.headers["x-correlation-id"] as string);
      res.json({ ok: true });
    });

    const res = await request(app).get("/test").set("X-Correlation-Id", "abc-123");
    expect(res.headers["x-correlation-id"]).toBe("abc-123");
  });

  it("generates a correlation ID when none provided", async () => {
    const { requestLogger } = await import("../middleware/requestLogger");
    const app = express();
    app.use(requestLogger);
    app.get("/test", (_req: Request, res: Response) => res.json({ ok: true }));

    const res = await request(app).get("/test");
    expect(res.headers["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe("legacy /api usage (#660)", () => {
  function appAt(now: number) {
    const app = express();
    app.use(
      "/api",
      legacyApiUsage(() => now),
    );
    app.get("/api/projects/:id", (_req: unknown, res: { json: (b: unknown) => void }) =>
      res.json({ ok: true }),
    );
    return app;
  }

  it("labels paths with low cardinality", () => {
    expect(legacyPathLabel("/api/projects/42/history?x=1")).toBe("/api/projects");
    expect(legacyPathLabel("/api/42")).toBe("/api/:id");
  });

  it("counts legacy requests and passes through before the sunset", async () => {
    const res = await request(appAt(LEGACY_SUNSET_DATE.getTime() - 1)).get("/api/projects/1");
    expect(res.status).toBe(200);
    const metrics = await register.getSingleMetricAsString("legacy_api_requests_total");
    expect(metrics).toContain('path="/api/projects"');
  });

  it("returns 410 Gone pointing at /v1 after the sunset", async () => {
    const res = await request(appAt(LEGACY_SUNSET_DATE.getTime())).get("/api/projects/1?a=b");
    expect(res.status).toBe(410);
    expect(res.body.error.successor).toBe("/v1/projects/1?a=b");
    expect(res.headers.link).toContain("/v1/projects/1");
  });
});
