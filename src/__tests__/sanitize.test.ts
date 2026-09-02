import request from "supertest";
import express, { Request, Response, NextFunction, Express } from "express";
import { sanitizeInputs } from "../middleware/sanitize";
import { errorHandler } from "../middleware/errors";

/**
 * Capture record that handlers fill with what they see after sanitizeInputs
 * has run, so tests can assert on the actual req state at the route handler.
 */
interface Captured {
  query?: unknown;
  params?: unknown;
  body?: unknown;
}

function capture(): Captured {
  return {};
}

/**
 * App mirroring the production mounting order (express.json -> sanitizeInputs
 * -> routes) so the tests exercise the real integration boundary.
 */
function buildApp(seen: Captured): Express {
  const app = express();
  app.use(express.json());
  app.use(sanitizeInputs);
  app.get("/echo/:projectId", (req: Request, res: Response) => {
    seen.params = req.params;
    seen.query = req.query;
    res.json({ ok: true });
  });
  app.post("/echo/:projectId", (req: Request, res: Response) => {
    seen.params = req.params;
    seen.query = req.query;
    seen.body = req.body;
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

/**
 * App with sanitizeInputs attached on the route itself — the position at which
 * Express 5 has already populated req.params, so per-key writes persist.
 */
function buildRouteLevelApp(seen: Captured): Express {
  const app = express();
  app.get("/echo/:projectId", sanitizeInputs, (req: Request, res: Response) => {
    seen.params = req.params;
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe("sanitizeInputs middleware", () => {
  let seen: Captured;
  let app: Express;

  beforeEach(() => {
    seen = capture();
    app = buildApp(seen);
  });

  it("sanitizes req.body as before (strips tags, keeps inner text)", async () => {
    const res = await request(app)
      .post("/echo/solar?project=1")
      .send({ name: "<script>alert(1)</script>Solar" })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(seen.body).toEqual({ name: "alert(1)Solar" });
  });

  it("sanitizes a query parameter containing HTML/script tags and writes the stripped result back", async () => {
    await request(app)
      .get(`/echo/solar?search=${encodeURIComponent("<script>alert(1)</script>panel")}`)
      .expect(200);
    expect(seen.query).toEqual({ search: "alert(1)panel" });
  });

  it("leaves non-string query values (arrays) unchanged", async () => {
    await request(app).get("/echo/solar?tag=a&tag=b").expect(200);
    expect(seen.query).toEqual({ tag: ["a", "b"] });
  });

  it("leaves a plain query value with no HTML unchanged", async () => {
    await request(app).get("/echo/solar?search=panel&limit=10").expect(200);
    expect(seen.query).toEqual({ search: "panel", limit: "10" });
  });

  it.each([
    ["1' OR '1'='1", "disallowed SQL pattern"],
    ["`whoami`", "disallowed command injection sequence"],
    ["../../etc/passwd", "path traversal sequence"],
  ])(
    "still rejects %p with a 400 for dangerous input in a query parameter",
    async (value, messagePart) => {
      const res = await request(app)
        .get(`/echo/solar?search=${encodeURIComponent(value)}`)
        .expect(400);
      expect(res.body.error.code).toBe("invalid_input");
      expect(res.body.error.message).toContain(messagePart);
    },
  );

  it("does not mutate req.body when it is absent", () => {
    const next = jest.fn() as NextFunction;
    const req = { query: {}, params: {} } as unknown as Request;
    const res = {} as Response;
    sanitizeInputs(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body).toBeUndefined();
  });

  describe("route parameters (persisted when the middleware sees populated params)", () => {
    it("sanitizes a route parameter containing HTML/script tags and writes the stripped result back", async () => {
      const routeApp = buildRouteLevelApp(seen);
      const raw = "<script>alert(1)</script>solar";
      await request(routeApp)
        .get(`/echo/${encodeURIComponent(raw)}`)
        .expect(200);
      expect(seen.params).toEqual({ projectId: "alert(1)solar" });
    });

    it("persists the sanitized param value on req.params via direct middleware invocation", () => {
      const next = jest.fn() as NextFunction;
      const req = {
        query: {},
        params: { projectId: "<b>solar</b>" },
      } as unknown as Request;
      const res = {} as Response;
      sanitizeInputs(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.params).toEqual({ projectId: "solar" });
    });

    it("still rejects a route parameter containing an SQL injection pattern", async () => {
      const routeApp = buildRouteLevelApp(seen);
      const res = await request(routeApp)
        .get(`/echo/${encodeURIComponent("1' OR '1'='1")}`)
        .expect(400);
      expect(res.body.error.code).toBe("invalid_input");
      expect(res.body.error.message).toContain("disallowed SQL pattern");
    });
  });
});
