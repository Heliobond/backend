import request from "supertest";
import express from "express";
import { errorHandler, ApiError, notFoundHandler } from "../middleware/errors";

function createAppWithError(throwFn: () => void) {
  const app = express();
  app.get("/error", (_req, _res, next) => {
    try {
      throwFn();
    } catch (err) {
      next(err);
    }
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("error handling middleware", () => {
  it("unhandled error returns 500 with JSON body and INTERNAL_ERROR code", async () => {
    const app = createAppWithError(() => {
      throw new Error("something broke");
    });
    const res = await request(app).get("/error").expect(500);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    });
  });

  it("stack trace is not in response", async () => {
    const app = createAppWithError(() => {
      throw new Error("internal failure");
    });
    const res = await request(app).get("/error").expect(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("at ");
    expect(body).not.toContain(".ts:");
    expect(body).not.toContain("Error:");
  });

  it("returns generic message, not the actual error", async () => {
    const app = createAppWithError(() => {
      throw new Error("secret database password leaked");
    });
    const res = await request(app).get("/error").expect(500);
    expect(res.body.error.message).toBe("An unexpected error occurred");
    expect(res.body.error.message).not.toContain("secret");
  });

  it("ApiError returns its own status and code", async () => {
    const app = createAppWithError(() => {
      throw new ApiError(422, "validation_failed", "bad input");
    });
    const res = await request(app).get("/error").expect(422);
    expect(res.body.error.code).toBe("validation_failed");
    expect(res.body.error.message).toBe("bad input");
  });

  it("catches async route handler errors", async () => {
    const app = express();
    app.get("/async-error", async () => {
      throw new Error("async failure");
    });
    app.use(notFoundHandler);
    app.use(errorHandler);

    const res = await request(app).get("/async-error").expect(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(res.body.error.message).toBe("An unexpected error occurred");
  });

  it("SyntaxError from malformed JSON returns 400", async () => {
    const app = express();
    app.use(express.json());
    app.post("/test", (_req, res) => res.json({ ok: true }));
    app.use(notFoundHandler);
    app.use(errorHandler);

    const res = await request(app)
      .post("/test")
      .set("Content-Type", "application/json")
      .send("{invalid json")
      .expect(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(res.body.error.message).toContain("JSON");
  });

  it("AnomalyValidationError returns 400 bad_request (#880)", async () => {
    const app = createAppWithError(() => {
      const err = new Error("sensitivityZScore must be a finite positive number");
      err.name = "AnomalyValidationError";
      throw err;
    });
    const res = await request(app).get("/error").expect(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(res.body.error.message).toContain("sensitivityZScore");
  });
});
