import { createBenchmarkSampleInitializer } from "../lib/benchmarkStartup";

describe("benchmark sample startup initialization", () => {
  it("uses the registry project count for a populated registry", async () => {
    const seedSamples = jest.fn();
    const initialize = createBenchmarkSampleInitializer({
      getTotalProjects: jest.fn().mockResolvedValue(37),
      seedSamples,
      warn: jest.fn(),
    });

    await expect(initialize()).resolves.toBe(37);
    expect(seedSamples).toHaveBeenCalledWith(37);
  });

  it("uses a safe minimum when the registry is empty", async () => {
    const seedSamples = jest.fn();
    const initialize = createBenchmarkSampleInitializer({
      getTotalProjects: jest.fn().mockResolvedValue(0),
      seedSamples,
      warn: jest.fn(),
    });

    await expect(initialize()).resolves.toBe(1);
    expect(seedSamples).toHaveBeenCalledWith(1);
  });

  it("caps the sample size for a very large registry", async () => {
    const seedSamples = jest.fn();
    const initialize = createBenchmarkSampleInitializer({
      getTotalProjects: jest.fn().mockResolvedValue(50_000),
      seedSamples,
      warn: jest.fn(),
    });

    await expect(initialize()).resolves.toBe(1000);
    expect(seedSamples).toHaveBeenCalledWith(1000);
  });

  it("uses the bounded default and logs when the registry lookup fails", async () => {
    const seedSamples = jest.fn();
    const warn = jest.fn();
    const initialize = createBenchmarkSampleInitializer({
      getTotalProjects: jest.fn().mockRejectedValue(new Error("RPC unavailable")),
      seedSamples,
      warn,
    });

    await expect(initialize()).resolves.toBe(20);
    expect(seedSamples).toHaveBeenCalledWith(20);
    expect(warn).toHaveBeenCalledWith(
      "[startup] benchmark project count unavailable, using default sample size",
      { sample_size: 20, error: "RPC unavailable" },
    );
  });

  it("reuses the first initialization and seeds only once", async () => {
    const getTotalProjects = jest.fn().mockResolvedValue(12);
    const seedSamples = jest.fn();
    const initialize = createBenchmarkSampleInitializer({
      getTotalProjects,
      seedSamples,
      warn: jest.fn(),
    });

    await Promise.all([initialize(), initialize(), initialize()]);

    expect(getTotalProjects).toHaveBeenCalledTimes(1);
    expect(seedSamples).toHaveBeenCalledTimes(1);
    expect(seedSamples).toHaveBeenCalledWith(12);
  });
});
