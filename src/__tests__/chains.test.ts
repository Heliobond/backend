import request from "supertest";
import express, { Express } from "express";
import chainsRouter from "../routes/chains";
import { errorHandler } from "../middleware/errors";
import * as multichain from "../lib/multichain";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";

jest.mock("../lib/multichain", () => ({
  getChains: jest.fn(),
  getEnabledChains: jest.fn(),
  getChain: jest.fn(),
  configureChain: jest.fn(),
  broadcastToChains: jest.fn(),
}));
jest.mock("../routes/iot");
jest.mock("../lib/scoring");

const stellarChain = {
  id: "stellar",
  name: "Stellar",
  enabled: true,
  rpcUrl: "https://rpc.example.com",
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/chains", chainsRouter);
  app.use(errorHandler);
  return app;
}

describe("chains routes", () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    (multichain.getChains as jest.Mock).mockReturnValue([stellarChain]);
    (multichain.getEnabledChains as jest.Mock).mockReturnValue([stellarChain]);
    (iot.getSolarData as jest.Mock).mockReturnValue({
      efficiency_pct: 85,
      power_output_kw: 500,
      max_power_kw: 1000,
    });
    (iot.getSatelliteData as jest.Mock).mockReturnValue({
      forest_density_pct: 60,
      ndvi_score: 0.6,
    });
    (scoring.computeScores as jest.Mock).mockReturnValue({
      credit_quality: 85,
      green_impact: 70,
    });
  });

  it("GET /v1/chains lists configured chains", async () => {
    const res = await request(app).get("/v1/chains").expect(200);
    expect(res.body.chains).toEqual([stellarChain]);
    expect(res.body.enabled).toEqual(["stellar"]);
  });

  it("GET /v1/chains/:id returns a chain or 404", async () => {
    (multichain.getChain as jest.Mock).mockReturnValue(stellarChain);
    const res = await request(app).get("/v1/chains/stellar").expect(200);
    expect(res.body).toEqual(stellarChain);

    (multichain.getChain as jest.Mock).mockReturnValue(undefined);
    await request(app).get("/v1/chains/missing").expect(404);
  });

  it("PATCH /v1/chains/:id configures a chain or returns 404", async () => {
    (multichain.configureChain as jest.Mock).mockReturnValue(true);
    const ok = await request(app).patch("/v1/chains/stellar").send({ enabled: false }).expect(200);
    expect(ok.body.ok).toBe(true);

    (multichain.configureChain as jest.Mock).mockReturnValue(false);
    await request(app).patch("/v1/chains/unknown").send({ enabled: false }).expect(404);
  });

  it("POST /v1/chains/broadcast/:projectId rejects non-Stellar chains", async () => {
    const res = await request(app)
      .post("/v1/chains/broadcast/1")
      .send({ chains: ["ethereum"] })
      .expect(501);
    expect(res.body.error).toContain("only Stellar");
  });

  it("POST /v1/chains/broadcast/:projectId broadcasts to Stellar", async () => {
    (multichain.broadcastToChains as jest.Mock).mockResolvedValue({
      ok: true,
      chains: ["stellar"],
      txHash: "abc123",
    });
    const res = await request(app)
      .post("/v1/chains/broadcast/1")
      .send({ chains: ["stellar"] })
      .expect(200);
    expect(res.body.txHash).toBe("abc123");
    expect(multichain.broadcastToChains).toHaveBeenCalledWith(1, 85, 70, ["stellar"]);
  });
});

describe("chains routes — admin auth stack (#831)", () => {
  let app: Express;
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_API_KEY = "test-admin-key";
    app = buildApp();
    (multichain.configureChain as jest.Mock).mockReturnValue(true);
    (multichain.getChain as jest.Mock).mockReturnValue(stellarChain);
    (multichain.getEnabledChains as jest.Mock).mockReturnValue([stellarChain]);
  });

  afterAll(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  const AUTH = { Authorization: "Bearer test-admin-key" };

  it("PATCH /v1/chains/:id rejects an unauthenticated request", async () => {
    await request(app).patch("/v1/chains/stellar").send({ enabled: false }).expect(401);
  });

  it("POST /v1/chains/broadcast/:projectId rejects an unauthenticated request", async () => {
    await request(app)
      .post("/v1/chains/broadcast/1")
      .send({ chains: ["stellar"] })
      .expect(401);
  });

  it("PATCH /v1/chains/:id accepts a valid admin bearer and valid payload", async () => {
    await request(app).patch("/v1/chains/stellar").set(AUTH).send({ enabled: true }).expect(200);
  });

  it("GET /v1/chains and GET /v1/chains/:id remain public reads", async () => {
    (multichain.getChains as jest.Mock).mockReturnValue([stellarChain]);
    await request(app).get("/v1/chains").expect(200);
    await request(app).get("/v1/chains/stellar").expect(200);
  });
});

describe("chains routes — PATCH input validation (#831)", () => {
  let app: Express;
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    // Keep ADMIN_API_KEY unset so requireAdminBearer passes through in the
    // test env — this suite focuses on the validator, not on auth.
    delete process.env.ADMIN_API_KEY;
    app = buildApp();
    (multichain.configureChain as jest.Mock).mockReturnValue(true);
    (multichain.getChain as jest.Mock).mockReturnValue(stellarChain);
  });

  afterAll(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  it("rejects an rpcUrl that resolves to a loopback address", async () => {
    await request(app)
      .patch("/v1/chains/stellar")
      .send({ rpcUrl: "http://127.0.0.1/rpc" })
      .expect(400);
    expect(multichain.configureChain).not.toHaveBeenCalled();
  });

  it("rejects an rpcUrl that is not an http(s) URL", async () => {
    await request(app)
      .patch("/v1/chains/stellar")
      .send({ rpcUrl: "file:///etc/passwd" })
      .expect(400);
    expect(multichain.configureChain).not.toHaveBeenCalled();
  });

  it("rejects a non-string rpcUrl", async () => {
    await request(app).patch("/v1/chains/stellar").send({ rpcUrl: 42 }).expect(400);
  });

  it("rejects a contractAddress that is not a valid Stellar contract strkey", async () => {
    await request(app)
      .patch("/v1/chains/stellar")
      .send({ contractAddress: "not-a-strkey" })
      .expect(400);
    expect(multichain.configureChain).not.toHaveBeenCalled();
  });

  it("accepts a valid contractAddress strkey", async () => {
    const valid = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
    await request(app).patch("/v1/chains/stellar").send({ contractAddress: valid }).expect(200);
    expect(multichain.configureChain).toHaveBeenCalledWith(
      "stellar",
      expect.objectContaining({ contractAddress: valid }),
    );
  });

  it("rejects a non-boolean enabled value", async () => {
    await request(app).patch("/v1/chains/stellar").send({ enabled: "yes" }).expect(400);
  });

  it("rejects an empty or overlong name", async () => {
    await request(app).patch("/v1/chains/stellar").send({ name: "" }).expect(400);
    await request(app)
      .patch("/v1/chains/stellar")
      .send({ name: "x".repeat(201) })
      .expect(400);
  });
});
