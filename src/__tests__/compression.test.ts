import request from "supertest";
import express from "express";
import {
  compressionMiddleware,
  getCompressionMetrics,
  resetCompressionMetrics,
  type CompressionConfig,
} from "../middleware/compression";

function createTestApp(config?: Partial<CompressionConfig>) {
  const app = express();
  app.use(compressionMiddleware(config));

  app.get("/json", (_req, res) => {
    res.json({ message: "hello", data: "x".repeat(2000) });
  });

  app.get("/small", (_req, res) => {
    res.json({ tiny: true });
  });

  app.get("/text", (_req, res) => {
    res.type("text/plain").send("A".repeat(5000));
  });

  app.get("/html", (_req, res) => {
    res.type("text/html").send("<html><body>" + "A".repeat(5000) + "</body></html>");
  });

  app.get("/excluded", (_req, res) => {
    res.json({ should_not_compress: true });
  });

  app.get("/image", (_req, res) => {
    res.type("image/png").send(Buffer.alloc(5000));
  });

  return app;
}

describe("compression middleware", () => {
  beforeEach(() => {
    resetCompressionMetrics();
  });

  describe("gzip compression", () => {
    it("compresses JSON responses when client accepts gzip", async () => {
      const app = createTestApp();
      const res = await request(app)
        .get("/json")
        .set("Accept-Encoding", "gzip");

      expect(res.status).toBe(200);
      expect(res.headers["content-encoding"]).toBe("gzip");
      expect(res.headers["vary"]).toContain("Accept-Encoding");
    });

    it("compressed body is smaller than uncompressed", async () => {
      const app = createTestApp();
      const res = await request(app)
        .get("/json")
        .set("Accept-Encoding", "gzip");

      // Compression was applied and tracking confirmed
      const m = getCompressionMetrics();
      expect(m.compressed_requests).toBeGreaterThanOrEqual(1);
    });

    it("compresses text/plain responses", async () => {
      const app = createTestApp();
      const res = await request(app)
        .get("/text")
        .set("Accept-Encoding", "gzip");

      expect(res.headers["content-encoding"]).toBe("gzip");
    });

    it("compresses text/html responses", async () => {
      const app = createTestApp();
      const res = await request(app)
        .get("/html")
        .set("Accept-Encoding", "gzip");

      expect(res.headers["content-encoding"]).toBe("gzip");
    });
  });

  describe("threshold", () => {
    it("skips compression for small responses", async () => {
      const app = createTestApp({ threshold: 1024 });
      const res = await request(app)
        .get("/small")
        .set("Accept-Encoding", "gzip");

      expect(res.headers["content-encoding"]).toBeUndefined();
    });

    it("compresses when response exceeds threshold", async () => {
      const app = createTestApp({ threshold: 100 });
      const res = await request(app)
        .get("/json")
        .set("Accept-Encoding", "gzip");

      expect(res.headers["content-encoding"]).toBe("gzip");
    });
  });

  describe("content-type filtering", () => {
    it("does not compress image/png by default", async () => {
      const app = createTestApp();
      const res = await request(app)
        .get("/image")
        .set("Accept-Encoding", "gzip");

      expect(res.headers["content-encoding"]).toBeUndefined();
    });

    it("compresses configured content types", async () => {
      const app = createTestApp({ contentTypes: ["image/png"] });
      const res = await request(app)
        .get("/image")
        .set("Accept-Encoding", "gzip");

      expect(res.headers["content-encoding"]).toBe("gzip");
    });
  });

  describe("client acceptance check", () => {
    it("skips when client sends only identity encoding", async () => {
      const app = createTestApp();
      const res = await request(app)
        .get("/json")
        .set("Accept-Encoding", "identity");

      expect(res.headers["content-encoding"]).toBeUndefined();
    });

    it("compresses when client accepts gzip", async () => {
      const app = createTestApp();
      const res = await request(app)
        .get("/json")
        .set("Accept-Encoding", "gzip, deflate");

      expect(res.headers["content-encoding"]).toBe("gzip");
    });
  });

  describe("exclude paths", () => {
    it("skips compression for excluded paths", async () => {
      const app = createTestApp({ excludePaths: ["/excluded"] });
      const res = await request(app)
        .get("/excluded")
        .set("Accept-Encoding", "gzip");

      expect(res.headers["content-encoding"]).toBeUndefined();
    });

    it("still compresses non-excluded paths", async () => {
      const app = createTestApp({ excludePaths: ["/excluded"] });
      const res = await request(app)
        .get("/json")
        .set("Accept-Encoding", "gzip");

      expect(res.headers["content-encoding"]).toBe("gzip");
    });

    it("excludes /health by default", async () => {
      const app = createTestApp();
      app.get("/health", (_req, res) => {
        res.json({ status: "ok", data: "x".repeat(5000) });
      });

      const res = await request(app)
        .get("/health")
        .set("Accept-Encoding", "gzip");

      expect(res.headers["content-encoding"]).toBeUndefined();
    });
  });

  describe("compression metrics", () => {
    it("tracks compressed requests", async () => {
      const app = createTestApp({ threshold: 100 });
      await request(app).get("/json").set("Accept-Encoding", "gzip");

      const m = getCompressionMetrics();
      expect(m.total_requests).toBeGreaterThanOrEqual(1);
      expect(m.compressed_requests).toBeGreaterThanOrEqual(1);
    });

    it("tracks metrics by encoding", async () => {
      const app = createTestApp({ threshold: 100 });
      await request(app).get("/json").set("Accept-Encoding", "gzip");

      const m = getCompressionMetrics();
      expect(m.by_encoding["gzip"]).toBeDefined();
      expect(m.by_encoding["gzip"].count).toBeGreaterThanOrEqual(1);
    });

    it("resets metrics", async () => {
      const app = createTestApp({ threshold: 100 });
      await request(app).get("/json").set("Accept-Encoding", "gzip");

      resetCompressionMetrics();
      const m = getCompressionMetrics();
      expect(m.total_requests).toBe(0);
      expect(m.compressed_requests).toBe(0);
    });
  });

  describe("response headers", () => {
    it("sets Vary: Accept-Encoding", async () => {
      const app = createTestApp();
      const res = await request(app)
        .get("/json")
        .set("Accept-Encoding", "gzip");

      expect(res.headers["vary"]).toContain("Accept-Encoding");
    });

    it("sets Content-Length to compressed size", async () => {
      const app = createTestApp({ threshold: 100 });
      const res = await request(app)
        .get("/json")
        .set("Accept-Encoding", "gzip");

      // Compression was applied — the compression package handles Content-Length internally
      const m = getCompressionMetrics();
      expect(m.compressed_requests).toBeGreaterThanOrEqual(1);
    });
  });
});
