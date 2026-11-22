import request from "supertest";
import express from "express";
import iotRouter from "../routes/iot";

const app = express();
app.use("/api/iot", iotRouter);

describe("GET /api/iot/solar/:id — response shape", () => {
  it("returns 200 with correct fields", async () => {
    const res = await request(app).get("/api/iot/solar/1").expect(200);
    expect(res.body).toHaveProperty("power_output_kw");
    expect(res.body).toHaveProperty("efficiency_pct");
    expect(res.body).toHaveProperty("max_power_kw");
    expect(res.body).toHaveProperty("timestamp");
  });

  it("all fields are numbers", async () => {
    const res = await request(app).get("/api/iot/solar/1").expect(200);
    expect(typeof res.body.power_output_kw).toBe("number");
    expect(typeof res.body.efficiency_pct).toBe("number");
    expect(typeof res.body.max_power_kw).toBe("number");
    expect(typeof res.body.timestamp).toBe("number");
  });

  it("timestamp is a valid number", async () => {
    const res = await request(app).get("/api/iot/solar/1").expect(200);
    expect(res.body.timestamp).toBeGreaterThan(0);
  });
});

describe("GET /api/iot/satellite/:id — response shape", () => {
  it("returns 200 with correct fields", async () => {
    const res = await request(app).get("/api/iot/satellite/1").expect(200);
    expect(res.body).toHaveProperty("forest_density_pct");
    expect(res.body).toHaveProperty("ndvi_score");
    expect(res.body).toHaveProperty("timestamp");
  });

  it("all fields are numbers", async () => {
    const res = await request(app).get("/api/iot/satellite/1").expect(200);
    expect(typeof res.body.forest_density_pct).toBe("number");
    expect(typeof res.body.ndvi_score).toBe("number");
    expect(typeof res.body.timestamp).toBe("number");
  });

  it("timestamp is a valid number", async () => {
    const res = await request(app).get("/api/iot/satellite/1").expect(200);
    expect(res.body.timestamp).toBeGreaterThan(0);
  });
});
