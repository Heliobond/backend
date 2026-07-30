// `crypto`'s exports are non-configurable, so the constant-time assertions below
// wrap timingSafeEqual through a module mock that still runs the real function.
const mockTimingSafeEqual = jest.fn();

jest.mock("crypto", () => {
  const actual = jest.requireActual<typeof import("crypto")>("crypto");
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      mockTimingSafeEqual(a, b);
      return actual.timingSafeEqual(a, b);
    },
  };
});

import { timingSafeCompare } from "../lib/timing-safe";

describe("timingSafeCompare (#209)", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeCompare("Bearer secret-key", "Bearer secret-key")).toBe(true);
  });

  it("returns false when a single character differs", () => {
    expect(timingSafeCompare("Bearer secret-key", "Bearer secret-keY")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(timingSafeCompare("short", "a-much-longer-value")).toBe(false);
    expect(timingSafeCompare("a-much-longer-value", "short")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(timingSafeCompare("", "")).toBe(true);
    expect(timingSafeCompare("", "Bearer key")).toBe(false);
  });

  it("is case sensitive", () => {
    expect(timingSafeCompare("bearer key", "Bearer key")).toBe(false);
  });

  it("compares multi-byte characters correctly", () => {
    expect(timingSafeCompare("clé-secrète", "clé-secrète")).toBe(true);
    expect(timingSafeCompare("clé-secrète", "cle-secrete")).toBe(false);
  });

  describe("constant-time guarantees", () => {
    beforeEach(() => {
      mockTimingSafeEqual.mockClear();
    });

    it("delegates to crypto.timingSafeEqual rather than ===", () => {
      timingSafeCompare("Bearer key", "Bearer key");
      expect(mockTimingSafeEqual).toHaveBeenCalledTimes(1);
    });

    it("never short-circuits: mismatches at any position still reach the full compare", () => {
      const key = "a".repeat(64);
      timingSafeCompare("b" + "a".repeat(63), key); // wrong at the first byte
      timingSafeCompare("a".repeat(63) + "b", key); // wrong at the last byte
      expect(mockTimingSafeEqual).toHaveBeenCalledTimes(2);
    });

    it("always compares equal-length buffers, so no length is leaked", () => {
      timingSafeCompare("x", "a-considerably-longer-secret-value");
      expect(mockTimingSafeEqual).toHaveBeenCalledTimes(1);

      const [a, b] = mockTimingSafeEqual.mock.calls[0] as [Buffer, Buffer];
      expect(a).toHaveLength(32);
      expect(b).toHaveLength(32);
    });
  });
});
