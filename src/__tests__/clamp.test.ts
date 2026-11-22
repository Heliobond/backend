import { clamp } from "../lib/scoring";

describe("clamp", () => {
  // ── Boundary values ──────────────────────────────────────────────────────

  it("returns the value unchanged when within range", () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it("returns min boundary value unchanged", () => {
    expect(clamp(0, 0, 100)).toBe(0);
  });

  it("returns max boundary value unchanged", () => {
    expect(clamp(100, 0, 100)).toBe(100);
  });

  it("clamps a value above max down to max", () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });

  it("clamps a value below min up to min", () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  // ── Negative inputs ──────────────────────────────────────────────────────

  it("passes through negative values within a negative range", () => {
    expect(clamp(-50, -100, 0)).toBe(-50);
  });

  it("clamps a very negative value to the negative min", () => {
    expect(clamp(-1000, -100, 0)).toBe(-100);
  });

  // ── NaN / Infinity behavior ──────────────────────────────────────────────

  it("returns 0 for NaN input regardless of range", () => {
    expect(clamp(NaN, 0, 100)).toBe(0);
  });

  it("returns 0 for NaN input even when 0 is outside the range", () => {
    expect(clamp(NaN, 10, 20)).toBe(0);
  });

  it("clamps +Infinity down to a finite max", () => {
    expect(clamp(Infinity, 0, 100)).toBe(100);
  });

  it("clamps -Infinity up to a finite min", () => {
    expect(clamp(-Infinity, 0, 100)).toBe(0);
  });

  it("allows Infinity through when max is Infinity", () => {
    expect(clamp(1000, 0, Infinity)).toBe(1000);
  });

  // ── min > max edge case ──────────────────────────────────────────────────

  it("when min > max, result collapses to min regardless of value", () => {
    expect(clamp(50, 100, 0)).toBe(100);
    expect(clamp(-50, 100, 0)).toBe(100);
    expect(clamp(1000, 100, 0)).toBe(100);
  });
});
