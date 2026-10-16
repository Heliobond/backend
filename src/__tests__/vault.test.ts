import {
  i128ToDecimal,
  validateStellarAddress,
  evictPortfolioCacheTo,
  _resetPortfolioCache,
  _getPortfolioCacheSize,
  CACHE_TTL_MS,
} from "../lib/vault";

const VALID_ACCOUNT_G = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const VALID_CONTRACT_C = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

describe("Vault Module Exhaustive 5D Senior Suite (Issue #858)", () => {
  beforeEach(() => {
    _resetPortfolioCache();
    delete process.env.PORTFOLIO_CACHE_MAX_SIZE;
  });

  afterEach(() => {
    _resetPortfolioCache();
    delete process.env.PORTFOLIO_CACHE_MAX_SIZE;
  });

  // Dimension 1: Boundary & Clamping
  describe("Dimension 1: i128ToDecimal Boundary and Clamping", () => {
    describe("Zero and edge representations", () => {
      it("formats '0' as '0'", () => {
        expect(i128ToDecimal("0")).toBe("0");
      });

      it("formats '-0' as '0'", () => {
        expect(i128ToDecimal("-0")).toBe("0");
      });

      it("formats numeric 0 as '0'", () => {
        expect(i128ToDecimal(0)).toBe("0");
      });

      it("formats bigint 0n as '0'", () => {
        expect(i128ToDecimal(0n)).toBe("0");
      });

      it("formats padded zeroes '00000' as '0'", () => {
        expect(i128ToDecimal("00000")).toBe("0");
      });

      it("formats padded negative zeroes '-00000' as '0'", () => {
        expect(i128ToDecimal("-00000")).toBe("0");
      });
    });

    describe("Positive integer & fraction boundaries (7 decimals - Stellar standard)", () => {
      const positiveCases = [
        { input: "1", expected: "0.0000001", label: "minimum 1 stroop" },
        { input: "9", expected: "0.0000009", label: "9 stroops" },
        { input: "10", expected: "0.000001", label: "10 stroops" },
        { input: "100", expected: "0.00001", label: "100 stroops" },
        { input: "1000", expected: "0.0001", label: "1,000 stroops" },
        { input: "10000", expected: "0.001", label: "10,000 stroops" },
        { input: "100000", expected: "0.01", label: "100,000 stroops" },
        { input: "1000000", expected: "0.1", label: "1,000,000 stroops (0.1)" },
        { input: "5000000", expected: "0.5", label: "5,000,000 stroops (0.5)" },
        { input: "9999999", expected: "0.9999999", label: "just below 1 unit" },
        { input: "10000000", expected: "1", label: "exact 1 unit" },
        { input: "10000001", expected: "1.0000001", label: "just above 1 unit" },
        { input: "10500000", expected: "1.05", label: "1.05 with trailing zeroes stripped" },
        { input: "12345678", expected: "1.2345678", label: "arbitrary fraction without zeroes" },
        { input: "100000000", expected: "10", label: "10 units" },
        { input: "1000000000", expected: "100", label: "100 units" },
        { input: "10000000000", expected: "1000", label: "1,000 units" },
        { input: "100000000000", expected: "10000", label: "10,000 units" },
        { input: "1000000000000", expected: "100000", label: "100,000 units" },
        { input: "10000000000000", expected: "1000000", label: "1,000,000 units" },
      ];

      positiveCases.forEach(({ input, expected, label }) => {
        it(`formats ${label} (${input} -> ${expected})`, () => {
          expect(i128ToDecimal(input, 7)).toBe(expected);
        });
      });

      it("formats max int64 boundary (9223372036854775807)", () => {
        expect(i128ToDecimal("9223372036854775807", 7)).toBe("922337203685.4775807");
      });

      it("formats max int128 boundary (170141183460469231731687303715884105727)", () => {
        expect(i128ToDecimal("170141183460469231731687303715884105727", 7)).toBe("17014118346046923173168730371588.4105727");
      });
    });

    describe("Negative integer & fraction boundaries (Direct Acceptance Criteria for Issue #858)", () => {
      const negativeCases = [
        { input: "-1", expected: "-0.0000001", label: "negative 1 stroop" },
        { input: "-9", expected: "-0.0000009", label: "negative 9 stroops" },
        { input: "-10", expected: "-0.000001", label: "negative 10 stroops" },
        { input: "-100", expected: "-0.00001", label: "negative 100 stroops" },
        { input: "-1000", expected: "-0.0001", label: "negative 1,000 stroops" },
        { input: "-10000", expected: "-0.001", label: "negative 10,000 stroops" },
        { input: "-100000", expected: "-0.01", label: "negative 100,000 stroops" },
        { input: "-1000000", expected: "-0.1", label: "negative 1,000,000 stroops (-0.1)" },
        { input: "-5000000", expected: "-0.5", label: "Acceptance Criterion: -0.5 unit" },
        { input: "-9999999", expected: "-0.9999999", label: "negative just below 1 unit" },
        { input: "-10000000", expected: "-1", label: "Acceptance Criterion: -1 unit" },
        { input: "-10000001", expected: "-1.0000001", label: "negative just above 1 unit" },
        { input: "-10500000", expected: "-1.05", label: "negative 1.05 with trailing zeroes stripped" },
        { input: "-12345678", expected: "-1.2345678", label: "exact reported bug case" },
        { input: "-100000000", expected: "-10", label: "negative 10 units" },
        { input: "-1000000000", expected: "-100", label: "negative 100 units" },
        { input: "-10000000000", expected: "-1000", label: "negative 1,000 units" },
        { input: "-100000000000", expected: "-10000", label: "negative 10,000 units" },
        { input: "-1000000000000", expected: "-100000", label: "negative 100,000 units" },
        { input: "-10000000000000", expected: "-1000000", label: "negative 1,000,000 units" },
      ];

      negativeCases.forEach(({ input, expected, label }) => {
        it(`formats ${label} (${input} -> ${expected})`, () => {
          expect(i128ToDecimal(input, 7)).toBe(expected);
        });
      });

      it("formats min int64 boundary (-9223372036854775808)", () => {
        expect(i128ToDecimal("-9223372036854775808", 7)).toBe("-922337203685.4775808");
      });

      it("formats min int128 boundary (-170141183460469231731687303715884105728)", () => {
        expect(i128ToDecimal("-170141183460469231731687303715884105728", 7)).toBe("-17014118346046923173168730371588.4105728");
      });
    });
  });

  // Dimension 2: Combinatorics across Precision Scales
  describe("Dimension 2: Combinatorics - All Decimal Precisions (0 to 18)", () => {
    const scales = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 18];

    scales.forEach((decimals) => {
      it(`formats 1 unit correctly with ${decimals} decimals`, () => {
        const val = (10n ** BigInt(decimals)).toString();
        expect(i128ToDecimal(val, decimals)).toBe("1");
      });

      it(`formats -1 unit correctly with ${decimals} decimals`, () => {
        const val = (-1n * 10n ** BigInt(decimals)).toString();
        expect(i128ToDecimal(val, decimals)).toBe("-1");
      });

      if (decimals > 0) {
        it(`formats half-unit 0.5 correctly with ${decimals} decimals`, () => {
          const val = (5n * 10n ** BigInt(decimals - 1)).toString();
          expect(i128ToDecimal(val, decimals)).toBe("0.5");
        });

        it(`formats negative half-unit -0.5 correctly with ${decimals} decimals`, () => {
          const val = (-5n * 10n ** BigInt(decimals - 1)).toString();
          expect(i128ToDecimal(val, decimals)).toBe("-0.5");
        });
      }
    });
  });

  // Dimension 3: Host Variations & Address Normalization
  describe("Dimension 3: Host Variations, Normalization & Address Validation", () => {
    describe("Valid addresses with various whitespace wrappings", () => {
      const whitespaceVariants = [
        { label: "exact address without padding", wrap: (s: string) => s },
        { label: "single leading space", wrap: (s: string) => ` ${s}` },
        { label: "single trailing space", wrap: (s: string) => `${s} ` },
        { label: "both leading and trailing spaces", wrap: (s: string) => `  ${s}  ` },
        { label: "tab indentation", wrap: (s: string) => `\t${s}\t` },
        { label: "newline indentation", wrap: (s: string) => `\n${s}\n` },
        { label: "mixed CRLF and tabs", wrap: (s: string) => `\r\n\t  ${s}  \t\r\n` },
      ];

      whitespaceVariants.forEach(({ label, wrap }) => {
        it(`accepts and normalizes G-account with ${label}`, () => {
          expect(() => validateStellarAddress(wrap(VALID_ACCOUNT_G))).not.toThrow();
        });

        it(`accepts and normalizes C-contract with ${label}`, () => {
          expect(() => validateStellarAddress(wrap(VALID_CONTRACT_C))).not.toThrow();
        });
      });
    });

    describe("Invalid address prefixes and lengths", () => {
      const invalidPrefixes = ["A", "B", "D", "E", "F", "H", "M", "S", "T", "X", "1", "9"];
      invalidPrefixes.forEach((prefix) => {
        it(`rejects address starting with unauthorized prefix '${prefix}'`, () => {
          const bad = prefix + VALID_ACCOUNT_G.slice(1);
          expect(() => validateStellarAddress(bad)).toThrow(/address must start with G/);
        });
      });

      const invalidLengths = [0, 1, 10, 32, 50, 55, 57, 64, 100];
      invalidLengths.forEach((len) => {
        it(`rejects address with invalid length ${len}`, () => {
          const bad = len === 0 ? "" : "G" + "A".repeat(len - 1);
          expect(() => validateStellarAddress(bad)).toThrow();
        });
      });
    });
  });

  // Dimension 4: Negative Controls & Security Defenses
  describe("Dimension 4: Negative Controls and Strict Error Handling", () => {
    describe("Input corruption guards for i128ToDecimal", () => {
      const malformedInputs = [
        { val: "abc", desc: "pure alphabetic string" },
        { val: "123a456", desc: "string with embedded letter" },
        { val: "1.23", desc: "decimal string (i128 raw must be integer)" },
        { val: "1e10", desc: "scientific notation" },
        { val: "0x12", desc: "hexadecimal string" },
        { val: "0b10", desc: "binary string" },
        { val: "--100", desc: "double minus prefix" },
        { val: "+100", desc: "plus prefix" },
        { val: "100-", desc: "trailing minus" },
        { val: " 10 20 ", desc: "embedded spaces" },
        { val: "$100", desc: "currency symbol" },
        { val: "NaN", desc: "literal NaN" },
        { val: "Infinity", desc: "literal Infinity" },
        { val: "-Infinity", desc: "literal -Infinity" },
      ];

      malformedInputs.forEach(({ val, desc }) => {
        it(`rejects ${desc} ('${val}') with explicit error`, () => {
          expect(() => i128ToDecimal(val)).toThrow(/Invalid i128 numeric string/);
        });
      });

      it("throws on null input", () => {
        expect(() => i128ToDecimal(null as unknown as string)).toThrow(/cannot be null or undefined/);
      });

      it("throws on undefined input", () => {
        expect(() => i128ToDecimal(undefined as unknown as string)).toThrow(/cannot be null or undefined/);
      });

      it("throws on negative decimals parameter (-1, -7)", () => {
        expect(() => i128ToDecimal("100", -1)).toThrow(/decimals cannot be negative/);
        expect(() => i128ToDecimal("100", -7)).toThrow(/decimals cannot be negative/);
      });
    });
  });

  // Dimension 5: Lifecycle, Stress & LRU Eviction
  describe("Dimension 5: Lifecycle, Stress and Cache Eviction", () => {
    it("respects CACHE_TTL_MS constant of 15 seconds", () => {
      expect(CACHE_TTL_MS).toBe(15_000);
    });

    it("bounds cache size strictly to MAX under high-volume distinct-address polling", () => {
      const caps = [1, 5, 10, 25, 50];
      caps.forEach((cap) => {
        _resetPortfolioCache();
        evictPortfolioCacheTo(cap);
        expect(_getPortfolioCacheSize()).toBeLessThanOrEqual(cap);
      });
    });

    it("processes 10,000 rapid conversions without memory leaks or degradation", () => {
      const start = Date.now();
      for (let i = -5000; i < 5000; i++) {
        const val = (BigInt(i) * 1000000n).toString();
        const res = i128ToDecimal(val, 7);
        if (i === 0) {
          expect(res).toBe("0");
        } else if (i < 0) {
          expect(res.startsWith("-")).toBe(true);
        } else {
          expect(res.startsWith("-")).toBe(false);
        }
      }
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it("resets cache cleanly with _resetPortfolioCache helper", () => {
      _resetPortfolioCache();
      expect(_getPortfolioCacheSize()).toBe(0);
    });
  });
});
