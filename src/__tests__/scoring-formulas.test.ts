import request from "supertest";
import express from "express";
import scoringFormulasRouter from "../routes/scoring-formulas";

const app = express();
app.use(express.json());
app.use("/v1/scoring/formulas", scoringFormulasRouter);

describe("scoring formulas routes", () => {
  it("GET /v1/scoring/formulas returns 200 with formulas", async () => {
    const res = await request(app).get("/v1/scoring/formulas");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.formulas)).toBe(true);
  });

  it("POST /v1/scoring/formulas creates a formula", async () => {
    const res = await request(app)
      .post("/v1/scoring/formulas")
      .send({ id: "f1", name: "Balanced", weights: { efficiency_weight: 1.5 } });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("f1");
  });

  it("POST /v1/scoring/formulas rejects a body without an id", async () => {
    const res = await request(app).post("/v1/scoring/formulas").send({ name: "No id" });
    expect(res.status).toBe(400);
  });

  it("POST /v1/scoring/formulas/validate validates weights", async () => {
    const ok = await request(app)
      .post("/v1/scoring/formulas/validate")
      .send({ weights: { efficiency_weight: 1 } });
    expect(ok.status).toBe(200);
    expect(ok.body.valid).toBe(true);

    const bad = await request(app)
      .post("/v1/scoring/formulas/validate")
      .send({ weights: { power_weight: 99 } });
    expect(bad.status).toBe(200);
    expect(bad.body.valid).toBe(false);
  });
});
