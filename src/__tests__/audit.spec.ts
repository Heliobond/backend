import request from "supertest";
import express, { Express } from "express";
import adminRouter from "../routes/admin";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import { clearAuditLog, getAuditLog, recordAudit, auditToCsv } from "../lib/audit";

jest.mock("../lib/registry");
jest.mock("../routes/iot");
jest.mock("../lib/scoring");

describe("audit trail", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/admin", adminRouter);
    process.env.ADMIN_API_KEY = "test-key";
    clearAuditLog();
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  describe("recordAudit / getAuditLog", () => {
    it("stores an audit entry and returns it with an id", () => {
      const entry = recordAudit({
        project_id: 1,
        credit_quality: 80,
        green_impact: 70,
        tx_hash: "tx-abc",
        triggered_by: "api",
      });
      expect(entry.id).toBe(1);
      expect(entry.project_id).toBe(1);
      expect(entry.credit_quality).toBe(80);
      expect(entry.triggered_by).toBe("api");
      expect(typeof entry.timestamp).toBe("number");
    });

    it("increments id monotonically across entries", () => {
      const a = recordAudit({ project_id: 1, credit_quality: 80, green_impact: 70, tx_hash: "tx1", triggered_by: "api" });
      const b = recordAudit({ project_id: 2, credit_quality: 90, green_impact: 60, tx_hash: "tx2", triggered_by: "cron" });
      expect(b.id).toBe(a.id + 1);
    });

    it("filters by project_id", () => {
      recordAudit({ project_id: 1, credit_quality: 80, green_impact: 70, tx_hash: "tx1", triggered_by: "api" });
      recordAudit({ project_id: 2, credit_quality: 90, green_impact: 60, tx_hash: "tx2", triggered_by: "api" });
      const results = getAuditLog({ project_id: 1 });
      expect(results).toHaveLength(1);
      expect(results[0].project_id).toBe(1);
    });

    it("filters by from/to time range", () => {
      const now = Date.now();
      recordAudit({ project_id: 1, credit_quality: 80, green_impact: 70, tx_hash: "tx-old", triggered_by: "api", timestamp: now - 10000 });
      recordAudit({ project_id: 1, credit_quality: 85, green_impact: 75, tx_hash: "tx-new", triggered_by: "api", timestamp: now });
      const results = getAuditLog({ from: now - 5000 });
      expect(results).toHaveLength(1);
      expect(results[0].tx_hash).toBe("tx-new");
    });
  });

  describe("auditToCsv", () => {
    it("produces a header row and one data row per entry", () => {
      const entry = recordAudit({ project_id: 1, credit_quality: 80, green_impact: 70, tx_hash: "tx-csv", triggered_by: "api" });
      const csv = auditToCsv([entry]);
      const lines = csv.trim().split("\n");
      expect(lines[0]).toBe("id,project_id,credit_quality,green_impact,tx_hash,triggered_by,timestamp");
      expect(lines[1]).toContain("tx-csv");
      expect(lines[1]).toContain("api");
    });
  });

  describe("GET /admin/audit", () => {
    it("returns empty audit log when no scores have been updated", async () => {
      const res = await request(app)
        .get("/admin/audit")
        .set("Authorization", "Bearer test-key")
        .expect(200);
      expect(res.body).toEqual({ count: 0, entries: [] });
    });

    it("records and returns an audit entry after POST /update-scores", async () => {
      (registry.getTotalProjects as jest.Mock).mockResolvedValue(1);
      (iot.getSolarData as jest.Mock).mockReturnValue({ efficiency_pct: 85, power_output_kw: 500, max_power_kw: 1000, timestamp: Date.now() });
      (iot.getSatelliteData as jest.Mock).mockReturnValue({ forest_density_pct: 60, ndvi_score: 0.6, timestamp: Date.now() });
      (scoring.computeScores as jest.Mock).mockReturnValue({ credit_quality: 85, green_impact: 70 });
      (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-audit-1");

      await request(app)
        .post("/admin/update-scores")
        .set("Authorization", "Bearer test-key")
        .send({})
        .expect(200);

      const res = await request(app)
        .get("/admin/audit")
        .set("Authorization", "Bearer test-key")
        .expect(200);

      expect(res.body.count).toBe(1);
      expect(res.body.entries[0]).toMatchObject({
        project_id: 1,
        credit_quality: 85,
        green_impact: 70,
        tx_hash: "tx-audit-1",
        triggered_by: "api",
      });
    });

    it("returns CSV when format=csv is requested", async () => {
      recordAudit({ project_id: 3, credit_quality: 90, green_impact: 80, tx_hash: "tx-csv-test", triggered_by: "cron" });

      const res = await request(app)
        .get("/admin/audit?format=csv")
        .set("Authorization", "Bearer test-key")
        .expect(200);

      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.text).toContain("tx-csv-test");
      expect(res.text).toContain("cron");
    });

    it("filters by project_id query param", async () => {
      recordAudit({ project_id: 1, credit_quality: 80, green_impact: 70, tx_hash: "tx-p1", triggered_by: "api" });
      recordAudit({ project_id: 2, credit_quality: 90, green_impact: 60, tx_hash: "tx-p2", triggered_by: "api" });

      const res = await request(app)
        .get("/admin/audit?project_id=1")
        .set("Authorization", "Bearer test-key")
        .expect(200);

      expect(res.body.count).toBe(1);
      expect(res.body.entries[0].project_id).toBe(1);
    });
  });
});
