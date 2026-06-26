import request from "supertest";
import express from "express";
import { getHealth, recordCronRun } from "../lib/health";

describe("health reporting", () => {
  it("reports ok status, numeric uptime, and a null cron run before any cron fires", () => {
    const health = getHealth();
    expect(health.status).toBe("ok");
    expect(typeof health.uptime_seconds).toBe("number");
    expect(health.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof health.started_at).toBe("string");
    expect(health.last_cron_run).toBeNull();
  });

  it("records the most recent cron run", () => {
    recordCronRun("score-update", "success");
    const health = getHealth();
    expect(health.last_cron_run).toMatchObject({
      name: "score-update",
      status: "success",
    });
    expect(typeof health.last_cron_run?.at).toBe("string");
  });

  it("exposes the report over GET /health as JSON 200", async () => {
    const app = express();
    app.get("/health", (_req, res) => res.json(getHealth()));

    const res = await request(app).get("/health").expect(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime_seconds).toBe("number");
    expect(res.body).toHaveProperty("last_cron_run");
  });
});
