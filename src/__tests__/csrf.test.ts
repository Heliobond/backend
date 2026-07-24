import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { csrfProtection, resetCsrfStore } from "../middleware/csrf";

describe("CSRF protection middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    resetCsrfStore();
    app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(csrfProtection);
    app.get("/test", (_req, res) => res.json({ ok: true }));
    app.post("/test", (_req, res) => res.json({ ok: true }));
  });

  it("allows GET requests without CSRF token", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("sets XSRF-TOKEN cookie on GET requests", async () => {
    const res = await request(app).get("/test");
    expect(res.headers["set-cookie"]).toBeDefined();
    const cookies = Array.isArray(res.headers["set-cookie"])
      ? res.headers["set-cookie"]
      : [res.headers["set-cookie"]];
    const cookie = cookies.find((c: string) => c.startsWith("XSRF-TOKEN="));
    expect(cookie).toBeDefined();
  });

  it("rejects POST requests without CSRF token", async () => {
    const res = await request(app).post("/test");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_token_missing");
  });

  it("accepts POST requests with valid CSRF token in header", async () => {
    const getRes = await request(app).get("/test");
    const cookies = Array.isArray(getRes.headers["set-cookie"])
      ? getRes.headers["set-cookie"]
      : [getRes.headers["set-cookie"]];
    const cookie = cookies.find((c: string) => c.startsWith("XSRF-TOKEN="));
    const token = cookie?.split("=")[1]?.split(";")[0];

    const postRes = await request(app)
      .post("/test")
      .set("X-CSRF-Token", token!)
      .send({});
    expect(postRes.status).toBe(200);
  });

  it("rejects POST requests with invalid CSRF token", async () => {
    const getRes = await request(app).get("/test");
    const cookies = Array.isArray(getRes.headers["set-cookie"])
      ? getRes.headers["set-cookie"]
      : [getRes.headers["set-cookie"]];
    const cookie = cookies.find((c: string) => c.startsWith("XSRF-TOKEN="));
    const token = cookie?.split("=")[1]?.split(";")[0];

    const postRes = await request(app)
      .post("/test")
      .set("X-CSRF-Token", "invalid-token")
      .send({});
    expect(postRes.status).toBe(403);
    expect(postRes.body.error).toBe("csrf_token_invalid");
  });

  it("accepts POST requests with CSRF token in body", async () => {
    const getRes = await request(app).get("/test");
    const cookies = Array.isArray(getRes.headers["set-cookie"])
      ? getRes.headers["set-cookie"]
      : [getRes.headers["set-cookie"]];
    const cookie = cookies.find((c: string) => c.startsWith("XSRF-TOKEN="));
    const token = cookie?.split("=")[1]?.split(";")[0];

    const postRes = await request(app)
      .post("/test")
      .send({ _csrf: token });
    expect(postRes.status).toBe(200);
  });
});
