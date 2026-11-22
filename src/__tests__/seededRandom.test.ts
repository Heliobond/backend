import { seededRandom } from "../routes/iot";

describe("seededRandom", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("returns a number in [0, 1)", () => {
    const value = seededRandom(1);
    expect(typeof value).toBe("number");
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });

  it("is deterministic: same project id + same hour → same output", () => {
    jest.setSystemTime(new Date("2026-07-29T10:15:00.000Z"));

    const first = seededRandom(42);
    const second = seededRandom(42);

    expect(first).toBe(second);
  });

  it("varies across different hours for the same project id", () => {
    // Sample several distinct hours and assert they don't all collapse to the
    // same value — guards against relying on a single pair that could, in
    // principle, hash-collide by chance.
    const hours = [
      "2026-07-29T10:15:00.000Z",
      "2026-07-29T11:15:00.000Z",
      "2026-07-29T12:15:00.000Z",
      "2026-07-30T03:15:00.000Z",
      "2026-08-15T22:15:00.000Z",
    ];

    const values = hours.map((iso) => {
      jest.setSystemTime(new Date(iso));
      return seededRandom(7);
    });

    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it("stays the same within the same hour even at different minutes/seconds", () => {
    jest.setSystemTime(new Date("2026-07-29T10:00:01.000Z").getTime());
    const early = seededRandom(9);

    jest.setSystemTime(new Date("2026-07-29T10:59:59.000Z").getTime());
    const late = seededRandom(9);

    expect(early).toBe(late);
  });

  it("varies across different project ids within the same hour", () => {
    jest.setSystemTime(new Date("2026-07-29T10:15:00.000Z"));

    const values = new Set([1, 2, 3, 4, 5].map((id) => seededRandom(id)));
    expect(values.size).toBe(5);
  });

  it("handles a NaN seed gracefully by treating it as 0", () => {
    jest.setSystemTime(new Date("2026-07-29T10:15:00.000Z"));

    const nanResult = seededRandom(NaN);
    const zeroResult = seededRandom(0);

    expect(nanResult).toBe(zeroResult);
    expect(Number.isNaN(nanResult)).toBe(false);
  });
});
