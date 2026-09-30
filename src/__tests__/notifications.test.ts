import request from "supertest";
import express from "express";
import notificationsRouter, { publicNotificationsRouter } from "../routes/notifications";
import { errorHandler } from "../middleware/errors";
import {
  notify,
  resetNotifications,
  updatePreferences,
  confirmEmail,
  signPayload,
} from "../lib/notifications";
import * as email from "../lib/email";
import * as ssrf from "../lib/ssrf";

jest.mock("../lib/email", () => ({ sendEmail: jest.fn().mockResolvedValue({ provider: "console", delivered: true }) }));
jest.mock("../lib/ssrf", () => ({ validatePublicUrl: jest.fn(async (u: string) => u) }));

const ADDR = "G" + "A".repeat(55);
const sendEmail = email.sendEmail as jest.Mock;

function confirmTokenFromEmail(): string {
  const body: string = sendEmail.mock.calls[0][0].body;
  return /token=([a-f0-9]+)/.exec(body)![1];
}

describe("investor notifications (#661)", () => {
  beforeEach(() => {
    resetNotifications();
    jest.clearAllMocks();
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  it("does not email until the address is confirmed (double opt-in)", async () => {
    await updatePreferences(ADDR, { email: "a@example.com" });
    expect(sendEmail).toHaveBeenCalledTimes(1); // confirmation only
    const r = await notify({ type: "yield_distributed", id: "e1", address: ADDR, data: { amount: 10 } });
    expect(r.email).toBe(0);

    expect(confirmEmail(confirmTokenFromEmail())).toBe(true);
    const r2 = await notify({ type: "yield_distributed", id: "e2", address: ADDR, data: { amount: 10 } });
    expect(r2.email).toBe(1);
    expect(sendEmail.mock.calls[1][0].body).toContain("/v1/notifications/unsubscribe?token=");
  });

  it("de-duplicates per event and channel", async () => {
    await updatePreferences(ADDR, { email: "a@example.com", webhook_url: "https://hooks.example.com/x" });
    confirmEmail(confirmTokenFromEmail());
    const ev = { type: "withdrawal_claimable", id: "w1", address: ADDR, data: { amount: 5 } } as const;
    expect(await notify(ev)).toEqual({ email: 1, webhook: 1 });
    expect(await notify(ev)).toEqual({ email: 0, webhook: 0 });
  });

  it("signs webhook payloads with the per-address secret", async () => {
    const { webhook_secret } = await updatePreferences(ADDR, { webhook_url: "https://hooks.example.com/x" });
    await notify({ type: "yield_distributed", id: "y1", address: ADDR, data: {} });
    const [, init] = (global as any).fetch.mock.calls[0];
    expect(init.headers["X-Heliobond-Signature"]).toBe(signPayload(init.body, webhook_secret!));
  });

  it("only sends score_changed above the threshold and for chosen projects", async () => {
    await updatePreferences(ADDR, { webhook_url: "https://hooks.example.com/x", score_change_threshold: 10, project_ids: [3] });
    const base = { type: "score_changed", address: undefined } as const;
    expect((await notify({ ...base, id: "a", project_id: 3, data: { credit_quality_delta: 4, green_impact_delta: 0 } })).webhook).toBe(0);
    expect((await notify({ ...base, id: "b", project_id: 4, data: { credit_quality_delta: 40, green_impact_delta: 0 } })).webhook).toBe(0);
    expect((await notify({ ...base, id: "c", project_id: 3, data: { credit_quality_delta: -12, green_impact_delta: 0 } })).webhook).toBe(1);
  });

  it("retries after a failed delivery instead of marking it delivered", async () => {
    await updatePreferences(ADDR, { webhook_url: "https://hooks.example.com/x" });
    (global as any).fetch.mockResolvedValue({ ok: false, status: 500 });
    const ev = { type: "yield_distributed", id: "f1", address: ADDR, data: {} } as const;
    expect((await notify(ev)).webhook).toBe(0);
    (global as any).fetch.mockResolvedValue({ ok: true, status: 200 });
    expect((await notify(ev)).webhook).toBe(1);
  });

  describe("HTTP", () => {
    const app = express();
    app.use(express.json());
    app.use("/n", publicNotificationsRouter);
    app.use("/n", notificationsRouter);
    app.use(errorHandler);

    it("reads and updates preferences, then confirms and unsubscribes", async () => {
      expect((await request(app).get(`/n/${ADDR}/preferences`)).status).toBe(404);
      const put = await request(app).put(`/n/${ADDR}/preferences`).send({ email: "a@example.com", events: ["yield_distributed"] });
      expect(put.status).toBe(200);
      expect(put.body.confirmation_sent).toBe(true);
      expect(put.body.preferences.email_verified).toBe(false);

      const confirm = await request(app).get(`/n/confirm?token=${confirmTokenFromEmail()}`);
      expect(confirm.body).toEqual({ confirmed: true });
      expect((await request(app).get(`/n/${ADDR}/preferences`)).body.email_verified).toBe(true);

      await notify({ type: "yield_distributed", id: "h1", address: ADDR, data: {} });
      const unsubToken = /unsubscribe\?token=([a-f0-9]+)/.exec(sendEmail.mock.calls[1][0].body)![1];
      expect((await request(app).get(`/n/unsubscribe?token=${unsubToken}`)).body).toEqual({ unsubscribed: true });
      expect((await request(app).get(`/n/${ADDR}/preferences`)).body.events).toEqual([]);
    });

    it("rejects bad addresses and bad input", async () => {
      expect((await request(app).get("/n/nope/preferences")).status).toBe(400);
      expect((await request(app).put(`/n/${ADDR}/preferences`).send({ email: "bad" })).status).toBe(400);
      expect((await request(app).put(`/n/${ADDR}/preferences`).send({ events: ["x"] })).status).toBe(400);
    });
  });
});
