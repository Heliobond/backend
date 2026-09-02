import request from "supertest";
import express, { Express } from "express";
import emailRouter from "../routes/email";
import { errorHandler } from "../middleware/errors";
import {
  isSignificant,
  setThresholds,
  renderTemplate,
  subscribe,
  unsubscribeByToken,
  clearSubscribers,
  sendAlertIfSignificant,
  sendDigest,
} from "../lib/email";

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
    expect(isSignificant({ project_id: 1, credit_quality_delta: 6, green_impact_delta: 0 })).toBe(
      true,
    );
    expect(isSignificant({ project_id: 1, credit_quality_delta: 1, green_impact_delta: 1 })).toBe(
      false,
    );
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

  describe("per-recipient fault isolation", () => {
    let consoleSpy: jest.SpyInstance;
    const FAKE_KEY = "SG.test-key";

    // We drive failures through the fetch mock so the real sendEmail code path
    // runs (spying on the module export wouldn't intercept the in-module call).
    let fetchMock: jest.MockedFunction<typeof fetch>;

    beforeEach(() => {
      // Start each test with a clean subscriber list so shared module state
      // from other tests doesn't bleed into the recipient counts.
      clearSubscribers();
      consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      fetchMock = jest.fn();
      global.fetch = fetchMock;
      process.env.SENDGRID_API_KEY = FAKE_KEY;
    });

    afterEach(() => {
      consoleSpy.mockRestore();
      delete process.env.SENDGRID_API_KEY;
      clearSubscribers();
    });

    it("sendAlertIfSignificant: a failing recipient does not prevent subsequent sends", async () => {
      const s1 = subscribe("iso-alert-1@example.com", "daily");
      const s2 = subscribe("iso-alert-2@example.com", "daily");
      const s3 = subscribe("iso-alert-3@example.com", "daily");

      // First send fails (e.g. bounced address), the other two succeed.
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 400 } as Response)
        .mockResolvedValue({ ok: true } as Response);

      setThresholds({ credit_quality_delta: 1, green_impact_delta: 1 });
      const sent = await sendAlertIfSignificant({
        project_id: 1,
        credit_quality_delta: 10,
        green_impact_delta: 10,
      });

      expect(sent).toBe(2);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0][0]).toMatch(/alert send failed/);
      // Three fetch calls were still attempted — the loop didn't stop early.
      expect(fetchMock).toHaveBeenCalledTimes(3);

      unsubscribeByToken(s1.unsubscribe_token);
      unsubscribeByToken(s2.unsubscribe_token);
      unsubscribeByToken(s3.unsubscribe_token);
    });

    it("sendDigest: a failing recipient does not prevent subsequent sends", async () => {
      const s1 = subscribe("iso-digest-1@example.com", "weekly");
      const s2 = subscribe("iso-digest-2@example.com", "weekly");
      const s3 = subscribe("iso-digest-3@example.com", "weekly");

      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 550 } as Response)
        .mockResolvedValue({ ok: true } as Response);

      const sent = await sendDigest("weekly", [
        { project_id: 1, credit_quality_delta: 5, green_impact_delta: 5 },
      ]);

      expect(sent).toBe(2);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0][0]).toMatch(/digest send failed/);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      unsubscribeByToken(s1.unsubscribe_token);
      unsubscribeByToken(s2.unsubscribe_token);
      unsubscribeByToken(s3.unsubscribe_token);
    });

    it("sendAlertIfSignificant: all recipients failing still resolves (no throw), returns 0", async () => {
      const s1 = subscribe("iso-all-fail-1@example.com", "daily");
      const s2 = subscribe("iso-all-fail-2@example.com", "daily");

      fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);

      setThresholds({ credit_quality_delta: 1, green_impact_delta: 1 });
      await expect(
        sendAlertIfSignificant({
          project_id: 99,
          credit_quality_delta: 10,
          green_impact_delta: 10,
        }),
      ).resolves.toBe(0);

      expect(consoleSpy).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      unsubscribeByToken(s1.unsubscribe_token);
      unsubscribeByToken(s2.unsubscribe_token);
    });
  });
});
