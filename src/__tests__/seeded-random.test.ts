import { seededRandom } from "../routes/iot";

describe("seededRandom", () => {
  const HOUR_MS = 3_600_000;
  let dateNowSpy: jest.SpyInstance;

  afterEach(() => {
    dateNowSpy?.mockRestore();
    jest.useRealTimers();
  });

  it("same project ID, same hour → same values", () => {
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(1000);
    const a = seededRandom(1);
    const b = seededRandom(1);
    expect(a).toBe(b);
  });

  it("same project ID, different hours → different values", () => {
    // seededRandom derives its seed from the current hour via getHourSeed(),
    // which reads `new Date()` — so mock the clock with fake timers rather
    // than Date.now (which getHourSeed never calls).
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const val1 = seededRandom(1);
    jest.setSystemTime(HOUR_MS);
    const val2 = seededRandom(1);
    jest.setSystemTime(HOUR_MS * 2);
    const val3 = seededRandom(1);

    expect(val1 === val2 && val2 === val3).toBe(false);
  });

  it("different project IDs → different values", () => {
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(1000);
    const a = seededRandom(1);
    const b = seededRandom(2);
    const c = seededRandom(3);
    const values = new Set([a, b, c]);
    expect(values.size).toBe(3);
  });

  it("returns a value in [0, 1)", () => {
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(1000);
    for (let i = 0; i < 100; i++) {
      const val = seededRandom(i);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it("values change across hours for same project ID", () => {
    jest.useFakeTimers();
    jest.setSystemTime(1000);
    const hour0 = seededRandom(42);
    jest.setSystemTime(1000 + HOUR_MS);
    const hour1 = seededRandom(42);
    jest.setSystemTime(1000 + HOUR_MS * 2);
    const hour2 = seededRandom(42);

    expect(hour0).not.toBe(hour1);
    expect(hour1).not.toBe(hour2);
  });
});
