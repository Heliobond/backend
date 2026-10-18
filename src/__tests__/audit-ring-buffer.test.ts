process.env.PROJECT_REGISTRY_CONTRACT_ID = "test-registry-contract-id";
process.env.ADMIN_API_KEY = "test-admin-key";
import request from "supertest";
import express, { Express } from "express";
import { config } from "../config";
(config as any).ADMIN_API_KEY = "test-admin-key";
import adminRouter from "../routes/admin";
import {
  clearAuditLog,
  getAuditLog,
  recordAudit,
  auditToCsv,
  setMaxAuditLogEntries,
  getMaxAuditLogEntries,
  getAuditStoreSize,
  DEFAULT_MAX_AUDIT_LOG_ENTRIES,
  MAX_AUDIT_LOG_ENTRIES,
  AuditEntry,
} from "../lib/audit";

jest.mock("../lib/registry");
jest.mock("../routes/iot");
jest.mock("../lib/scoring");

import { errorHandler } from "../middleware/errors";

const getAuthHeaders = (token = "test-admin-key") => ({
  Authorization: `Bearer ${token}`,
  "x-request-timestamp": Date.now().toString(),
});

describe("Audit Log Ring Buffer & Pagination (Issue #926)", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/admin", adminRouter);
    app.use(errorHandler);
    (config as any).ADMIN_API_KEY = "test-admin-key";
    process.env.ADMIN_API_KEY = "test-admin-key";
    clearAuditLog();
    jest.clearAllMocks();
  });

  afterEach(() => {
    clearAuditLog();
  });

  // Boundary & Clamping
  describe("Boundary and Clamping", () => {
    it("1.1 defaults to DEFAULT_MAX_AUDIT_LOG_ENTRIES when env is unset", () => {
      expect(DEFAULT_MAX_AUDIT_LOG_ENTRIES).toBe(1000);
      expect(getMaxAuditLogEntries()).toBeGreaterThanOrEqual(1000);
    });

    it("1.2 returns empty array and zero store size initially", () => {
      expect(getAuditStoreSize()).toBe(0);
      expect(getAuditLog()).toEqual([]);
    });

    const capSizes = [1, 2, 3, 5, 10, 25];
    capSizes.forEach((cap) => {
      it(`1.3 respects custom cap of ${cap} and evicts oldest entry upon overflow`, () => {
        setMaxAuditLogEntries(cap);
        expect(getMaxAuditLogEntries()).toBe(cap);

        for (let i = 1; i <= cap + 5; i++) {
          recordAudit({
            project_id: i,
            credit_quality: 80,
            green_impact: 70,
            tx_hash: `0xtx-${i}`,
            triggered_by: "api",
          });
        }

        expect(getAuditStoreSize()).toBe(cap);
        const entries = getAuditLog();
        expect(entries).toHaveLength(cap);
        // Oldest 5 entries (1..5) should have been evicted; first surviving is 6
        expect(entries[0].project_id).toBe(6);
        expect(entries[entries.length - 1].project_id).toBe(cap + 5);
      });
    });

    it("1.4 maintains monotonic sequence ID across evictions", () => {
      setMaxAuditLogEntries(3);
      for (let i = 1; i <= 6; i++) {
        const entry = recordAudit({
          project_id: i,
          credit_quality: 50,
          green_impact: 50,
          tx_hash: `tx-${i}`,
          triggered_by: "cron",
        });
        expect(entry.id).toBe(i);
      }
      const entries = getAuditLog();
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.id)).toEqual([4, 5, 6]);
    });

    const boundaryLimits = [
      { raw: "1", expectedLimit: 1 },
      { raw: "50", expectedLimit: 50 },
      { raw: "100", expectedLimit: 100 },
      { raw: "101", expectedLimit: 100 }, // Clamped to 100
      { raw: "200", expectedLimit: 100 }, // Clamped to 100
      { raw: "0", expectedLimit: 50 }, // 0 falls back to default 50
    ];

    boundaryLimits.forEach(({ raw, expectedLimit }, idx) => {
      it(`1.5.${idx + 1} clamps or defaults limit=${raw} to ${expectedLimit}`, async () => {
        for (let i = 1; i <= 10; i++) {
          recordAudit({
            project_id: i,
            credit_quality: 75,
            green_impact: 80,
            tx_hash: `hash-${i}`,
            triggered_by: "admin",
          });
        }

        const res = await request(app)
          .get(`/admin/audit?limit=${raw}`)
          .set(getAuthHeaders())
          .expect(200);

        expect(res.body.limit).toBe(expectedLimit);
        expect(res.body.total).toBe(10);
        expect(res.body.count).toBe(Math.min(10, expectedLimit));
      });
    });

    const boundaryOffsets = [0, 1, 5, 9, 10, 15];
    boundaryOffsets.forEach((offset, idx) => {
      it(`1.6.${idx + 1} handles boundary offset=${offset} correctly`, async () => {
        for (let i = 1; i <= 10; i++) {
          recordAudit({
            project_id: i,
            credit_quality: 80,
            green_impact: 70,
            tx_hash: `hash-${i}`,
            triggered_by: "admin",
          });
        }

        const res = await request(app)
          .get(`/admin/audit?limit=3&offset=${offset}`)
          .set(getAuthHeaders())
          .expect(200);

        expect(res.body.offset).toBe(offset);
        expect(res.body.total).toBe(10);
        if (offset >= 10) {
          expect(res.body.count).toBe(0);
          expect(res.body.entries).toEqual([]);
          expect(res.body.has_more).toBe(false);
        } else {
          const expectedCount = Math.min(3, 10 - offset);
          expect(res.body.count).toBe(expectedCount);
          expect(res.body.has_more).toBe(offset + expectedCount < 10);
        }
      });
    });

    it("1.7 dynamically trims in-memory store when cap is lowered", () => {
      for (let i = 1; i <= 20; i++) {
        recordAudit({
          project_id: i,
          credit_quality: 70,
          green_impact: 70,
          tx_hash: `hash-${i}`,
          triggered_by: "api",
        });
      }
      expect(getAuditStoreSize()).toBe(20);

      setMaxAuditLogEntries(8);
      expect(getAuditStoreSize()).toBe(8);
      const remaining = getAuditLog();
      expect(remaining[0].project_id).toBe(13);
      expect(remaining[7].project_id).toBe(20);
    });
  });

  // Query Filtering and Pagination Combinations
  describe("Filtering and Pagination Combinations", () => {
    beforeEach(() => {
      const baseTime = 1700000000000;
      // Populate 30 diverse records
      for (let i = 1; i <= 30; i++) {
        recordAudit({
          project_id: (i % 3) + 1, // 1, 2, 3
          credit_quality: 70 + (i % 25),
          green_impact: 60 + (i % 35),
          tx_hash: `0xhash-${i}`,
          triggered_by: i % 2 === 0 ? "api" : "cron",
          timestamp: baseTime + i * 1000,
        });
      }
    });

    const projectCombinations = [1, 2, 3];
    const limits = [5, 10];
    const offsets = [0, 5];

    projectCombinations.forEach((pid) => {
      limits.forEach((lim) => {
        offsets.forEach((off) => {
          it(`2.1 pairwise filter project_id=${pid}, limit=${lim}, offset=${off}`, async () => {
            const res = await request(app)
              .get(`/admin/audit?project_id=${pid}&limit=${lim}&offset=${off}`)
              .set(getAuthHeaders())
              .expect(200);

            expect(res.body.total).toBe(10); // 30 / 3 = 10 for each project
            expect(res.body.limit).toBe(lim);
            expect(res.body.offset).toBe(off);
            res.body.entries.forEach((entry: AuditEntry) => {
              expect(entry.project_id).toBe(pid);
            });
            const expectedCount = Math.max(0, Math.min(lim, 10 - off));
            expect(res.body.count).toBe(expectedCount);
            expect(res.body.has_more).toBe(off + expectedCount < 10);
          });
        });
      });
    });

    it("2.2 paginates across 3 consecutive pages without duplicate or missing items", async () => {
      const page1 = await request(app)
        .get("/admin/audit?limit=10&offset=0")
        .set(getAuthHeaders())
        .expect(200);
      const page2 = await request(app)
        .get("/admin/audit?limit=10&offset=10")
        .set(getAuthHeaders())
        .expect(200);
      const page3 = await request(app)
        .get("/admin/audit?limit=10&offset=20")
        .set(getAuthHeaders())
        .expect(200);

      expect(page1.body.has_more).toBe(true);
      expect(page2.body.has_more).toBe(true);
      expect(page3.body.has_more).toBe(false);

      const allIds = [
        ...page1.body.entries.map((e: AuditEntry) => e.id),
        ...page2.body.entries.map((e: AuditEntry) => e.id),
        ...page3.body.entries.map((e: AuditEntry) => e.id),
      ];

      expect(allIds).toHaveLength(30);
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(30);
    });

    it("2.3 combines time-window from/to filtering with pagination", async () => {
      const baseTime = 1700000000000;
      const from = baseTime + 5000;
      const to = baseTime + 15000; // items 5 through 15 inclusive = 11 items

      const res = await request(app)
        .get(`/admin/audit?from=${from}&to=${to}&limit=5&offset=2`)
        .set(getAuthHeaders())
        .expect(200);

      expect(res.body.total).toBe(11);
      expect(res.body.count).toBe(5);
      expect(res.body.has_more).toBe(true);
      expect(res.body.entries[0].timestamp).toBe(from + 2000); // offset 2 -> 7th item
    });
  });

  // Formats and Serialization
  describe("Formats and Serialization", () => {
    it("3.1 exports full filtered set as CSV when format=csv", async () => {
      recordAudit({
        project_id: 1,
        credit_quality: 85,
        green_impact: 90,
        tx_hash: "tx-csv-1",
        triggered_by: "admin",
      });
      recordAudit({
        project_id: 2,
        credit_quality: 75,
        green_impact: 80,
        tx_hash: "tx-csv-2",
        triggered_by: "cron",
      });

      const res = await request(app)
        .get("/admin/audit?format=csv")
        .set(getAuthHeaders())
        .expect(200);

      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.headers["content-disposition"]).toBe('attachment; filename="audit-log.csv"');
      const lines = res.text.trim().split("\n");
      expect(lines[0]).toBe(
        "id,project_id,credit_quality,green_impact,tx_hash,triggered_by,timestamp",
      );
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("tx-csv-1");
      expect(lines[2]).toContain("tx-csv-2");
    });

    it("3.2 respects project_id filter in CSV export", async () => {
      recordAudit({
        project_id: 10,
        credit_quality: 85,
        green_impact: 90,
        tx_hash: "tx-10",
        triggered_by: "admin",
      });
      recordAudit({
        project_id: 20,
        credit_quality: 75,
        green_impact: 80,
        tx_hash: "tx-20",
        triggered_by: "cron",
      });

      const res = await request(app)
        .get("/admin/audit?format=csv&project_id=10")
        .set(getAuthHeaders())
        .expect(200);

      expect(res.text).toContain("tx-10");
      expect(res.text).not.toContain("tx-20");
    });

    it("3.3 auditToCsv handles empty array with headers only", () => {
      const csv = auditToCsv([]);
      expect(csv).toBe(
        "id,project_id,credit_quality,green_impact,tx_hash,triggered_by,timestamp\n",
      );
    });

    it("3.4 preserves backwards-compatibility: response includes both count and total", async () => {
      for (let i = 1; i <= 5; i++) {
        recordAudit({
          project_id: i,
          credit_quality: 70,
          green_impact: 70,
          tx_hash: `tx-${i}`,
          triggered_by: "api",
        });
      }

      const res = await request(app).get("/admin/audit").set(getAuthHeaders()).expect(200);

      expect(res.body).toHaveProperty("total", 5);
      expect(res.body).toHaveProperty("count", 5);
      expect(res.body).toHaveProperty("limit", 50);
      expect(res.body).toHaveProperty("offset", 0);
      expect(res.body).toHaveProperty("has_more", false);
      expect(Array.isArray(res.body.entries)).toBe(true);
    });
  });

  // Invalid Parameters and Error Handling
  describe("Invalid Parameters and Error Handling", () => {
    it("4.1 rejects unauthorized requests without auth header with 401", async () => {
      await request(app).get("/admin/audit").expect(401);
    });

    it("4.2 rejects invalid API key with 401", async () => {
      await request(app).get("/admin/audit").set(getAuthHeaders("wrong-key")).expect(401);
    });

    it("4.3 rejects reversed time boundaries (from > to) with 400 badRequest", async () => {
      const res = await request(app)
        .get("/admin/audit?from=2000&to=1000")
        .set(getAuthHeaders())
        .expect(400);

      expect(res.body.error.message).toMatch(/from must be earlier than to/i);
    });

    const invalidParams = [
      { param: "project_id=abc", expectedField: "project_id" },
      { param: "from=invalid", expectedField: "from" },
      { param: "to=not_a_number", expectedField: "to" },
      { param: "limit=foo", expectedField: "limit" },
      { param: "offset=bar", expectedField: "offset" },
      { param: "limit=-5", expectedField: "limit" },
      { param: "offset=-1", expectedField: "offset" },
    ];

    invalidParams.forEach(({ param, expectedField }, idx) => {
      it(`4.4.${idx + 1} rejects invalid query parameter ${param} with 400`, async () => {
        const res = await request(app)
          .get(`/admin/audit?${param}`)
          .set(getAuthHeaders())
          .expect(400);

        expect(res.body.error.message).toContain(expectedField);
      });
    });

    it("4.5 querying nonexistent project_id returns 0 entries with 200 OK", async () => {
      recordAudit({
        project_id: 1,
        credit_quality: 80,
        green_impact: 80,
        tx_hash: "tx-1",
        triggered_by: "api",
      });

      const res = await request(app)
        .get("/admin/audit?project_id=999")
        .set(getAuthHeaders())
        .expect(200);

      expect(res.body.total).toBe(0);
      expect(res.body.count).toBe(0);
      expect(res.body.entries).toEqual([]);
      expect(res.body.has_more).toBe(false);
    });
  });

  // Store Lifecycle and High Throughput
  describe("Store Lifecycle and High Throughput", () => {
    it("5.1 stress-writes 2,000 entries into cap of 100 without memory exhaustion", () => {
      setMaxAuditLogEntries(100);

      const startTime = Date.now();
      for (let i = 1; i <= 2000; i++) {
        recordAudit({
          project_id: (i % 50) + 1,
          credit_quality: 50 + (i % 50),
          green_impact: 40 + (i % 60),
          tx_hash: `0xstress-${i}`,
          triggered_by: "stress-test",
          timestamp: startTime + i,
        });
      }

      expect(getAuditStoreSize()).toBe(100);
      const remaining = getAuditLog();
      expect(remaining).toHaveLength(100);
      expect(remaining[0].id).toBe(1901);
      expect(remaining[99].id).toBe(2000);
    });

    it("5.2 clearAuditLog resets both memory and sequence counter", () => {
      recordAudit({
        project_id: 1,
        credit_quality: 70,
        green_impact: 70,
        tx_hash: "tx-a",
        triggered_by: "api",
      });
      recordAudit({
        project_id: 2,
        credit_quality: 70,
        green_impact: 70,
        tx_hash: "tx-b",
        triggered_by: "api",
      });
      expect(getAuditStoreSize()).toBe(2);

      clearAuditLog();
      expect(getAuditStoreSize()).toBe(0);

      const fresh = recordAudit({
        project_id: 9,
        credit_quality: 90,
        green_impact: 90,
        tx_hash: "tx-c",
        triggered_by: "api",
      });
      expect(fresh.id).toBe(1);
    });

    it("5.3 50 rapid sequential pagination queries remain sub-second", async () => {
      setMaxAuditLogEntries(500);
      for (let i = 1; i <= 500; i++) {
        recordAudit({
          project_id: i,
          credit_quality: 80,
          green_impact: 80,
          tx_hash: `0xhash-${i}`,
          triggered_by: "api",
        });
      }

      const t0 = Date.now();
      for (let i = 0; i < 50; i++) {
        const offset = (i * 10) % 500;
        await request(app)
          .get(`/admin/audit?limit=10&offset=${offset}`)
          .set(getAuthHeaders())
          .expect(200);
      }
      const duration = Date.now() - t0;
      expect(duration).toBeLessThan(3000); // 50 requests under 3s
    });
  });
});
