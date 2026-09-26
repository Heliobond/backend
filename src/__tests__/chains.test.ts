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
