import request from "supertest";
import express, { Express } from "express";
import satelliteSourcesRouter from "../routes/satellite-sources";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/satellite-sources", satelliteSourcesRouter);
  app.use(errorHandler);
  return app;
}

describe("satellite-sources routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("GET /v1/satellite-sources — lists built-in sources with health", async () => {
    const res = await request(app).get("/v1/satellite-sources").expect(200);
    expect(res.body.sources.length).toBeGreaterThanOrEqual(2);
    expect(res.body.sources.map((s: { name: string }) => s.name)).toEqual(
      expect.arrayContaining(["sentinel-2", "landsat-8"]),
    );
  });

  it("POST /v1/satellite-sources — registers a source with a public fetchUrl", async () => {
    const res = await request(app)
      .post("/v1/satellite-sources")
      .send({ name: "custom-source", priority: 5, fetchUrl: "https://example.com/data" })
      .expect(201);

    expect(res.body).toMatchObject({ ok: true, name: "custom-source", priority: 5 });
  });

  it("POST /v1/satellite-sources — 400 when fetchUrl is missing", async () => {
    const res = await request(app)
      .post("/v1/satellite-sources")
      .send({ name: "custom-source" })
      .expect(400);

    expect(res.body.error).toBe("fetchUrl is required");
  });

  it("POST /v1/satellite-sources — 400 for an invalid URL", async () => {
    const res = await request(app)
      .post("/v1/satellite-sources")
      .send({ name: "custom-source", fetchUrl: "not-a-url" })
      .expect(400);

    expect(res.body.error).toBe("url must be a valid http/https URL");
  });

  it("POST /v1/satellite-sources — 400 for non-http(s) protocols", async () => {
    const res = await request(app)
      .post("/v1/satellite-sources")
      .send({ name: "custom-source", fetchUrl: "ftp://example.com/data" })
      .expect(400);

    expect(res.body.error).toBe("url must be a valid http/https URL");
  });

  it("POST /v1/satellite-sources — 400 for loopback URLs (SSRF)", async () => {
    const res = await request(app)
      .post("/v1/satellite-sources")
      .send({ name: "custom-source", fetchUrl: "http://127.0.0.1:8080/data" })
      .expect(400);

    expect(res.body.error).toBe(
      "url must not point to a private, loopback, link-local, or metadata address",
    );
  });

  it("POST /v1/satellite-sources — 400 for private IP URLs (SSRF)", async () => {
    const res = await request(app)
      .post("/v1/satellite-sources")
      .send({ name: "custom-source", fetchUrl: "http://10.0.0.1/data" })
      .expect(400);

    expect(res.body.error).toBe(
      "url must not point to a private, loopback, link-local, or metadata address",
    );
  });

  it("POST /v1/satellite-sources — 400 for cloud metadata URLs (SSRF)", async () => {
    const res = await request(app)
      .post("/v1/satellite-sources")
      .send({ name: "custom-source", fetchUrl: "http://169.254.169.254/latest/meta-data" })
      .expect(400);

    expect(res.body.error).toBe(
      "url must not point to a private, loopback, link-local, or metadata address",
    );
  });

  it("POST /v1/satellite-sources — 400 for IPv6 loopback URLs (SSRF)", async () => {
    const res = await request(app)
      .post("/v1/satellite-sources")
      .send({ name: "custom-source", fetchUrl: "http://[::1]/data" })
      .expect(400);

    expect(res.body.error).toBe(
      "url must not point to a private, loopback, link-local, or metadata address",
    );
  });

  it("GET /v1/satellite-sources/fetch/:projectId — returns a reading via fallback", async () => {
    const res = await request(app).get("/v1/satellite-sources/fetch/42").expect(200);
    expect(res.body).toMatchObject({
      forest_density_pct: expect.any(Number),
      ndvi_score: expect.any(Number),
      dataSource: "live",
    });
  });
});
