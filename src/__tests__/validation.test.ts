import request from "supertest";
import express, { Express } from "express";
import iotRouter from "../routes/iot";
import {
  errorHandler,
  notFoundHandler,
  parseProjectId,
  maxProjectId,
  MAX_PROJECT_ID,
} from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/iot", iotRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("request validation + structured errors", () => {
  const app = buildApp();

  it("returns 200 with data for a valid project id", async () => {
    const res = await request(app).get("/api/iot/solar/1").expect(200);
    expect(typeof res.body.power_output_kw).toBe("number");
  });

  it("returns 400 { error, message } for a non-numeric id", async () => {
    const res = await request(app).get("/api/iot/solar/abc").expect(400);
    expect(res.body).toEqual({
      error: {
        code: "bad_request",
        message: expect.stringContaining("positive integer"),
      },
    });
  });

  it("returns 400 for a zero id", async () => {
    const res = await request(app).get("/api/iot/satellite/0").expect(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("returns 400 for a negative / malformed id", async () => {
    const res = await request(app).get("/api/iot/satellite/-3").expect(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("returns a JSON 404 for unknown routes (no stack trace)", async () => {
    const res = await request(app).get("/api/iot/does-not-exist").expect(404);
    expect(res.body).toEqual({
      error: {
        code: "not_found",
        message: expect.stringContaining("/api/iot/does-not-exist"),
      },
    });
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await request(app)
      .post("/api/iot/solar/1")
      .set("Content-Type", "application/json")
      .send('{ "bad": ')
      .expect(400);
    expect(res.body).toEqual({
      error: {
        code: "bad_request",
        message: "Request body is not valid JSON",
      },
    });
  });
});

describe("project id bounds", () => {
  const app = buildApp();

  it("defaults the upper bound to 100000", () => {
    expect(maxProjectId()).toBe(MAX_PROJECT_ID);
    expect(MAX_PROJECT_ID).toBe(100_000);
  });

  it("accepts the highest allowed id", () => {
    expect(parseProjectId("100000", "project id")).toBe(100_000);
  });

  it("rejects an id one past the upper bound", () => {
    expect(() => parseProjectId("100001", "project id")).toThrow(/not exceeding 100000/);
  });

  it.each(["1.5", "0.9", "-5", "+5", "1e6", " 7", "7 ", "0x10", "Infinity", "NaN", "abc"])(
    "rejects %p as a project id",
    (raw) => {
      expect(() => parseProjectId(raw, "project id")).toThrow(/positive integer/);
    },
  );

  it("returns 400 over HTTP for a very large id", async () => {
    const res = await request(app).get("/api/iot/solar/999999999999").expect(400);
    expect(res.body).toEqual({
      error: { code: "bad_request", message: expect.stringContaining("not exceeding") },
    });
  });

  it("returns 400 over HTTP for a float id", async () => {
    const res = await request(app).get("/api/iot/solar/1.5").expect(400);
    expect(res.body).toEqual({
      error: { code: "bad_request", message: expect.stringContaining("positive integer") },
    });
  });

  it("still serves an id inside the valid range", async () => {
    await request(app).get("/api/iot/solar/100000").expect(200);
  });
});
