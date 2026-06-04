import { getSolarData, getSatelliteData } from "../routes/iot";

describe("getSolarData", () => {
  it("returns expected shape", () => {
    const data = getSolarData(1);
    expect(typeof data.power_output_kw).toBe("number");
    expect(typeof data.efficiency_pct).toBe("number");
    expect(typeof data.max_power_kw).toBe("number");
    expect(typeof data.timestamp).toBe("number");
  });

  it("efficiency_pct is in 40–98 range", () => {
    for (let i = 0; i < 10; i++) {
      const { efficiency_pct } = getSolarData(i + 1);
      expect(efficiency_pct).toBeGreaterThanOrEqual(40);
      expect(efficiency_pct).toBeLessThanOrEqual(98);
    }
  });

  it("different project IDs produce different values", () => {
    expect(getSolarData(1).power_output_kw).not.toBe(getSolarData(2).power_output_kw);
  });
});

describe("getSatelliteData", () => {
  it("returns expected shape with valid ranges", () => {
    const data = getSatelliteData(1);
    expect(data.forest_density_pct).toBeGreaterThanOrEqual(0);
    expect(data.forest_density_pct).toBeLessThanOrEqual(100);
    expect(data.ndvi_score).toBeGreaterThanOrEqual(0);
    expect(data.ndvi_score).toBeLessThanOrEqual(1);
  });
});
