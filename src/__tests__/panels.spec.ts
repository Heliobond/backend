import request from "supertest";
import express, { Express } from "express";
import panelsRouter from "../routes/panels";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/panels", panelsRouter);
  app.use(errorHandler);
  return app;
}

const validConfig = {
  panel_type: "monocrystalline",
  efficiency_rating: 21.5,
  capacity_kw: 500,
  orientation: "S",
  tilt_angle: 30,
  shading_factor: 0.1,
};

describe("solar panel configuration routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("PUT /panels/:id — stores a valid configuration", async () => {
    const res = await request(app).put("/panels/1").send(validConfig).expect(200);
    expect(res.body).toMatchObject({ project_id: 1, panel_type: "monocrystalline", capacity_kw: 500 });
    // 500 * (1 - 0.1) = 450
    expect(res.body.effective_capacity_kw).toBe(450);
  });

  it("PUT /panels/:id — rejects an invalid panel type", async () => {
    await request(app)
      .put("/panels/2")
      .send({ ...validConfig, panel_type: "graphene" })
      .expect(400);
  });

  it("PUT /panels/:id — rejects out-of-range tilt", async () => {
    await request(app)
      .put("/panels/2")
      .send({ ...validConfig, tilt_angle: 120 })
      .expect(400);
  });

  it("GET /panels/:id — 404 when unset", async () => {
    await request(app).get("/panels/999").expect(404);
  });

  it("PATCH /panels/:id — partial update keeps other fields", async () => {
    await request(app).put("/panels/3").send(validConfig).expect(200);
    const res = await request(app).patch("/panels/3").send({ tilt_angle: 45 }).expect(200);
    expect(res.body.tilt_angle).toBe(45);
    expect(res.body.panel_type).toBe("monocrystalline");
  });

  it("PATCH /panels/:id — 400 when no config exists", async () => {
    await request(app).patch("/panels/777").send({ tilt_angle: 10 }).expect(400);
  });
});
