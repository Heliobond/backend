import request from "supertest";
import express, { Express } from "express";
import emailRouter from "../routes/email";
import { errorHandler } from "../middleware/errors";
import { isSignificant, setThresholds, renderTemplate } from "../lib/email";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/email", emailRouter);
  app.use(errorHandler);
  return app;
}

describe("email notification system", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("subscribe then unsubscribe via token", async () => {
    const sub = await request(app)
      .post("/email/subscribe")
      .send({ email: "Alice@Example.com", frequency: "daily" })
      .expect(201);
    expect(sub.body.email).toBe("alice@example.com");
    expect(sub.body.unsubscribe_token).toBeTruthy();

    await request(app)
      .get(`/email/unsubscribe?token=${sub.body.unsubscribe_token}`)
      .expect(200)
      .expect({ unsubscribed: true });
  });

  it("rejects an invalid email", async () => {
    await request(app).post("/email/subscribe").send({ email: "not-an-email" }).expect(400);
  });

  it("unsubscribe with unknown token 404s", async () => {
    await request(app).get("/email/unsubscribe?token=nope").expect(404);
  });

  it("updates and reads alert thresholds", async () => {
    const res = await request(app)
      .put("/email/thresholds")
      .send({ credit_quality_delta: 12 })
      .expect(200);
    expect(res.body.credit_quality_delta).toBe(12);
  });

  it("manages templates", async () => {
    await request(app)
      .put("/email/templates")
      .send({ name: "welcome", subject: "Hi {{name}}", body: "Welcome {{name}}" })
      .expect(200);
    const list = await request(app).get("/email/templates").expect(200);
    expect(list.body.templates.some((t: { name: string }) => t.name === "welcome")).toBe(true);
  });

  it("isSignificant respects configured thresholds", () => {
    setThresholds({ credit_quality_delta: 5, green_impact_delta: 5 });
    expect(isSignificant({ project_id: 1, credit_quality_delta: 6, green_impact_delta: 0 })).toBe(true);
    expect(isSignificant({ project_id: 1, credit_quality_delta: 1, green_impact_delta: 1 })).toBe(false);
  });

  it("renderTemplate substitutes placeholders", () => {
    const { subject } = renderTemplate("score-alert", { project_id: 7, cq_delta: 3, gi_delta: 2 });
    expect(subject).toBe("Score alert for project 7");
  });

  it("digest send returns a count (no subscribers => 0)", async () => {
    const res = await request(app)
      .post("/email/digest")
      .send({ frequency: "weekly", changes: [] })
      .expect(200);
    expect(typeof res.body.sent).toBe("number");
  });
});
