import request from "supertest";
import express, { Express } from "express";
import iotRouter from "../routes/iot";
import { errorHandler, notFoundHandler } from "../middleware/errors";

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
      error: "bad_request",
      message: expect.stringContaining("positive integer"),
    });
  });

  it("returns 400 for a zero id", async () => {
    const res = await request(app).get("/api/iot/satellite/0").expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("returns 400 for a negative / malformed id", async () => {
    const res = await request(app).get("/api/iot/satellite/-3").expect(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("returns a JSON 404 for unknown routes (no stack trace)", async () => {
    const res = await request(app).get("/api/iot/does-not-exist").expect(404);
    expect(res.body).toEqual({
      error: "not_found",
      message: expect.stringContaining("/api/iot/does-not-exist"),
    });
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await request(app)
      .post("/api/iot/solar/1")
      .set("Content-Type", "application/json")
      .send('{ "bad": ')
      .expect(400);
    expect(res.body).toEqual({
      error: "bad_request",
      message: "Request body is not valid JSON",
    });
  });
});
