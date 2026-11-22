import request from "supertest";
import express from "express";
import adminRouter from "../routes/admin";
import { errorHandler } from "../middleware/errors";
import { setAuditSink, writeAuditLog } from "../lib/audit-logger";
import { resetIdempotencyState } from "../lib/scoreService";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";

jest.mock("../lib/registry", () => ({
  updateImpactScore: jest.fn(),
  getTotalProjects: jest.fn(),
  RpcDegradedError: class extends Error {},
}));
jest.mock("../routes/iot");
jest.mock("../config", () => ({
  config: { ADMIN_API_KEY: "test-key", ADMIN_REQUEST_MAX_AGE_MS: 300000 },
}));

describe("structured admin audit log (#542)", () => {
  const lines: string[] = [];
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use(errorHandler);
  const headers = () => ({
    Authorization: "Bearer test-key",
    "x-request-timestamp": Date.now().toString(),
  });

  beforeEach(() => {
    lines.length = 0;
    setAuditSink((l) => lines.push(l));
    resetIdempotencyState();
    jest.clearAllMocks();
    (iot.getSolarData as jest.Mock).mockReturnValue({
      efficiency_pct: 85,
      power_output_kw: 500,
      max_power_kw: 1000,
    });
    (iot.getSatelliteData as jest.Mock).mockReturnValue({
      forest_density_pct: 60,
      ndvi_score: 0.6,
    });
    (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-1");
  });
  afterEach(() => setAuditSink(undefined));

  it("writes one JSON line per line with a timestamp", () => {
    writeAuditLog({
      action: "a",
      correlation_id: "c",
      ip: "1.2.3.4",
      user_agent: "jest",
      project_ids: [1],
      success: true,
    });
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ action: "a", ip: "1.2.3.4", project_ids: [1], success: true });
    expect(new Date(parsed.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("never throws when the sink fails", () => {
    setAuditSink(() => {
      throw new Error("disk full");
    });
    expect(() =>
      writeAuditLog({
        action: "x",
        correlation_id: "c",
        ip: null,
        user_agent: null,
        project_ids: [],
        success: false,
      }),
    ).not.toThrow();
  });

  it("audits a successful update-scores call", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(headers())
      .set("User-Agent", "audit-test")
      .send({ project_ids: [1] });
    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      action: "admin.update-scores",
      user_agent: "audit-test",
      project_ids: [1],
      success: true,
      results: { updated: [1], failed: [], skipped: [] },
    });
    expect(JSON.parse(lines[0]).ip).toEqual(expect.any(String));
    expect(JSON.parse(lines[0]).correlation_id).toEqual(expect.any(String));
  });

  it("audits a failed call with the error", async () => {
    const res = await request(app)
      .post("/api/admin/update-scores")
      .set(headers())
      .send({ project_ids: ["x"] });
    expect(res.status).toBe(400);
    expect(JSON.parse(lines[0])).toMatchObject({
      action: "admin.update-scores",
      success: false,
      error: expect.any(String),
    });
  });

  it("extracts and includes contract_error_name and code from error string", () => {
    writeAuditLog({
      action: "admin.contract-call",
      correlation_id: "corr-1",
      ip: null,
      user_agent: null,
      project_ids: [1],
      success: false,
      error: "transaction failed: HostError: Error(Contract, #8)",
    });
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      action: "admin.contract-call",
      success: false,
      error: "transaction failed: HostError: Error(Contract, #8)",
      contract_error_name: "ScoresOutOfRange",
      contract_error_code: 8,
    });
  });
});
