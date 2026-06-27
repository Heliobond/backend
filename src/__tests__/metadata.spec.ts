import request from "supertest";
import express, { Express } from "express";
import metadataRouter from "../routes/metadata";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/metadata", metadataRouter);
  app.use(errorHandler);
  return app;
}

const valid = {
  name: "Sunfield Array A",
  description: "Rooftop installation",
  location: { label: "Lagos, Nigeria", latitude: 6.5244, longitude: 3.3792 },
  installation_date: "2025-03-01",
  custom: { warranty_years: 25, certified: true },
};

describe("project metadata routes", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("PUT /metadata/:id — stores valid metadata and includes panel_config field", async () => {
    const res = await request(app).put("/metadata/1").send(valid).expect(200);
    expect(res.body).toMatchObject({ project_id: 1, name: "Sunfield Array A" });
    expect(res.body).toHaveProperty("panel_config");
  });

  it("PUT /metadata/:id — rejects a bad installation_date", async () => {
    await request(app)
      .put("/metadata/2")
      .send({ ...valid, installation_date: "March 2025" })
      .expect(400);
  });

  it("PUT /metadata/:id — rejects missing location label", async () => {
    await request(app)
      .put("/metadata/2")
      .send({ ...valid, location: { latitude: 1 } })
      .expect(400);
  });

  it("PUT /metadata/:id — rejects a non-scalar custom field", async () => {
    await request(app)
      .put("/metadata/2")
      .send({ ...valid, custom: { nested: { a: 1 } } })
      .expect(400);
  });

  it("PATCH /metadata/:id — merges custom fields", async () => {
    await request(app).put("/metadata/3").send(valid).expect(200);
    const res = await request(app).patch("/metadata/3").send({ custom: { inverter: "SMA" } }).expect(200);
    expect(res.body.custom).toMatchObject({ warranty_years: 25, inverter: "SMA" });
  });

  it("GET /metadata/:id — 404 when unset", async () => {
    await request(app).get("/metadata/999").expect(404);
  });
});
