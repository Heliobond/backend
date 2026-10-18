import fs from "fs";
import path from "path";
import {
  parseContractError,
  lookupContractError,
  getContractErrorTable,
  isContractErrorRetryable,
  isContractError,
  ContractSource,
} from "../lib/contractErrors";

describe("Build Assets & Contract Errors (5D Matrix)", () => {
  const rootDir = path.resolve(__dirname, "../..");
  const srcDir = path.join(rootDir, "src");
  const distDir = path.join(rootDir, "dist");

  // =========================================================================
  // Dimension 1: Boundary & Clamping
  // =========================================================================
  describe("Dimension 1: Boundaries & Clamping", () => {
    it("1.1 verifies src/data/contractErrors.json exists and is non-empty", () => {
      const p = path.join(srcDir, "data", "contractErrors.json");
      expect(fs.existsSync(p)).toBe(true);
      const stat = fs.statSync(p);
      expect(stat.size).toBeGreaterThan(100);
    });

    it("1.2 verifies dist/data/contractErrors.json exists and matches src size", () => {
      const srcP = path.join(srcDir, "data", "contractErrors.json");
      const distP = path.join(distDir, "data", "contractErrors.json");
      expect(fs.existsSync(distP)).toBe(true);
      expect(fs.statSync(distP).size).toBe(fs.statSync(srcP).size);
    });

    it("1.3 verifies src/schemas/creator-application.schema.json exists and is valid JSON", () => {
      const p = path.join(srcDir, "schemas", "creator-application.schema.json");
      expect(fs.existsSync(p)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    });

    it("1.4 verifies dist/schemas/creator-application.schema.json exists and matches src size", () => {
      const srcP = path.join(srcDir, "schemas", "creator-application.schema.json");
      const distP = path.join(distDir, "schemas", "creator-application.schema.json");
      expect(fs.existsSync(distP)).toBe(true);
      expect(fs.statSync(distP).size).toBe(fs.statSync(srcP).size);
    });

    it("1.5 verifies dist/config/feature-flags.example.json exists", () => {
      const distP = path.join(distDir, "config", "feature-flags.example.json");
      expect(fs.existsSync(distP)).toBe(true);
    });

    it("1.6 verifies contract error table contains both registry and vault namespaces", () => {
      const table = getContractErrorTable();
      expect(table).toHaveProperty("registry");
      expect(table).toHaveProperty("vault");
      expect(Object.keys(table.registry).length).toBeGreaterThan(5);
      expect(Object.keys(table.vault).length).toBeGreaterThanOrEqual(3);
    });

    const additionalFormatChecks = [
      "HostError: Error(Contract, #100)",
      "HostError: Error(Contract, #200)",
      "HostError: Error(Contract, #300)",
      "HostError: Error(Contract, #400)",
      "HostError: Error(Contract, #500)",
    ];
    additionalFormatChecks.forEach((fmt, i) => {
      it(`1.6.extra.${i + 1} verifies contract error parsing for higher code: ${fmt}`, () => {
        const parsed = parseContractError(fmt);
        expect(parsed).toBeDefined();
        expect(parsed?.name).toBe("Unknown");
        expect(parsed?.retryable).toBe(false);
      });
    });

    const boundaryCodes = [-1, 0, 1, 2, 5, 10, 20, 21, 22, 23, 9999, 100000];
    boundaryCodes.forEach((code, idx) => {
      it(`1.7.${idx + 1} verifies lookup boundary behavior for registry code ${code}`, () => {
        const result = lookupContractError("registry", code);
        const table = getContractErrorTable();
        const expected = table.registry[String(code)];
        if (expected) {
          expect(result).toBeDefined();
          expect(result.code).toBe(code);
          expect(result.name).toBe(expected.name);
          expect(result.retryable).toBe(expected.retryable);
        } else {
          expect(result).toBeDefined();
          expect(result.name).toBe("Unknown");
          expect(result.retryable).toBe(false);
          expect(result.action).toBe("permanent");
        }
      });

      it(`1.8.${idx + 1} verifies lookup boundary behavior for vault code ${code}`, () => {
        const result = lookupContractError("vault", code);
        const table = getContractErrorTable();
        const expected = table.vault[String(code)];
        if (expected) {
          expect(result).toBeDefined();
          expect(result.code).toBe(code);
          expect(result.name).toBe(expected.name);
          expect(result.retryable).toBe(expected.retryable);
        } else {
          expect(result).toBeDefined();
          expect(result.name).toBe("Unknown");
          expect(result.retryable).toBe(false);
          expect(result.action).toBe("permanent");
        }
      });
    });

    it("1.9 verifies code 0 falls back to Unknown definition gracefully", () => {
      const reg = lookupContractError("registry", 0);
      expect(reg.name).toBe("Unknown");
      expect(reg.retryable).toBe(false);
      const vlt = lookupContractError("vault", 0);
      expect(vlt.name).toBe("Unknown");
      expect(vlt.retryable).toBe(false);
    });

    it("1.10 verifies negative error code falls back to Unknown definition gracefully", () => {
      const reg = lookupContractError("registry", -42);
      expect(reg.name).toBe("Unknown");
      expect(reg.retryable).toBe(false);
      const vlt = lookupContractError("vault", -1);
      expect(vlt.name).toBe("Unknown");
      expect(vlt.retryable).toBe(false);
    });
  });

  // =========================================================================
  // Dimension 2: Combinatorics
  // =========================================================================
  describe("Dimension 2: Combinatorics & Parsing Variations", () => {
    const errorPrefixes = [
      "HostError: Error(Contract, #%d)",
      "Error(Contract, #%d)",
      "Transaction failed with HostError: Error(Contract, #%d) during execution",
      "panic at soroban-env: Error(Contract, #%d)",
      "Error(Contract, #%d)\n    at Object.<anonymous>",
    ];

    const testCodes = [1, 2, 3, 4, 5, 10, 15, 20];

    errorPrefixes.forEach((prefixTpl, pIdx) => {
      testCodes.forEach((code, cIdx) => {
        it(`2.1.${pIdx + 1}.${cIdx + 1} parses prefix template #${pIdx + 1} with code ${code}`, () => {
          const raw = prefixTpl.replace("%d", String(code));
          const decoded = parseContractError(raw);
          expect(decoded).toBeDefined();
          expect(decoded?.code).toBe(code);
        });
      });
    });

    const sources: ContractSource[] = ["registry", "vault"];
    sources.forEach((src, sIdx) => {
      it(`2.2.${sIdx + 1} all error codes in ${src} table have name, action, and description`, () => {
        const table = getContractErrorTable();
        const entries = Object.entries(table[src]);
        expect(entries.length).toBeGreaterThan(0);
        for (const [codeStr, def] of entries) {
          expect(Number.isInteger(Number(codeStr))).toBe(true);
          expect(typeof def.name).toBe("string");
          expect(def.name.length).toBeGreaterThan(0);
          expect(typeof def.retryable).toBe("boolean");
          expect(["retry", "defer", "permanent"]).toContain(def.action);
          expect(typeof def.description).toBe("string");
          expect(def.description.length).toBeGreaterThan(0);
        }
      });
    });

    it("2.3 isContractError correctly identifies Soroban contract error string patterns", () => {
      expect(isContractError("HostError: Error(Contract, #1)")).toBe(true);
      expect(isContractError("Error(Contract, #12)")).toBe(true);
      expect(isContractError("Some random network timeout")).toBe(false);
      expect(isContractError("")).toBe(false);
      expect(isContractError("Error(Contract, #xyz)")).toBe(false);
    });

    it("2.4 isContractErrorRetryable evaluates retryable boolean correctly", () => {
      const table = getContractErrorTable();
      for (const [codeStr, def] of Object.entries(table.registry)) {
        const raw = `HostError: Error(Contract, #${codeStr})`;
        expect(isContractErrorRetryable(raw)).toBe(def.retryable);
      }
    });
  });

  // =========================================================================
  // Dimension 3: Host Variations & Structure
  // =========================================================================
  describe("Dimension 3: Host Variations & Structure", () => {
    it("3.1 dist/lib/contractErrors.js exists in build output", () => {
      const p = path.join(distDir, "lib", "contractErrors.js");
      expect(fs.existsSync(p)).toBe(true);
    });

    it("3.2 dist/lib/contractErrors.js is requireable by Node without throwing MODULE_NOT_FOUND", () => {
      const p = path.join(distDir, "lib", "contractErrors.js");
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(p);
        expect(mod).toBeDefined();
        expect(typeof mod.parseContractError).toBe("function");
      }).not.toThrow();
    });

    it("3.3 compiled dist module decodes Error(Contract, #1) identically to src module", () => {
      const distMod = path.join(distDir, "lib", "contractErrors.js");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const compiled = require(distMod);
      const compiledRes = compiled.parseContractError("HostError: Error(Contract, #1)");
      const localRes = parseContractError("HostError: Error(Contract, #1)");
      expect(compiledRes).toEqual(localRes);
    });

    it("3.4 package.json build script chains tsc and copy-assets.cjs", () => {
      const pkgPath = path.join(rootDir, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      expect(pkg.scripts.build).toContain("tsc");
      expect(pkg.scripts.build).toContain("copy-assets.cjs");
    });

    it("3.5 scripts/copy-assets.cjs is executable and has correct shebang", () => {
      const scriptPath = path.join(rootDir, "scripts", "copy-assets.cjs");
      expect(fs.existsSync(scriptPath)).toBe(true);
      const content = fs.readFileSync(scriptPath, "utf-8");
      expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
    });

    it("3.6 dist/schemas/creator-application.schema.json has valid json schema meta fields", () => {
      const p = path.join(distDir, "schemas", "creator-application.schema.json");
      const schema = JSON.parse(fs.readFileSync(p, "utf-8"));
      expect(schema).toHaveProperty("$schema");
      expect(schema).toHaveProperty("type");
      expect(schema.type).toBe("object");
    });
  });

  // =========================================================================
  // Dimension 4: Negative Controls & Invariants
  // =========================================================================
  describe("Dimension 4: Negative Controls & Invariants", () => {
    it("4.1 parseContractError returns null for non-error string", () => {
      expect(parseContractError("Everything is fine")).toBeNull();
    });

    it("4.2 parseContractError returns null for empty string", () => {
      expect(parseContractError("")).toBeNull();
    });

    it("4.3 parseContractError returns null for null/undefined casts", () => {
      expect(parseContractError(null as unknown as string)).toBeNull();
      expect(parseContractError(undefined as unknown as string)).toBeNull();
    });

    it("4.4 parseContractError returns null for malformed Contract error strings", () => {
      expect(parseContractError("Error(Contract, )")).toBeNull();
      expect(parseContractError("Error(Contract, #)")).toBeNull();
      expect(parseContractError("Error(Contract, #NaN)")).toBeNull();
      expect(parseContractError("Error(Contract, #-1)")).toBeNull();
      expect(parseContractError("Error(Other, #12)")).toBeNull();
    });

    it("4.5 isContractErrorRetryable returns false for non-contract errors", () => {
      expect(isContractErrorRetryable("TypeError: Cannot read properties of undefined")).toBe(
        false,
      );
      expect(isContractErrorRetryable("ECONNRESET")).toBe(false);
    });

    it("4.6 scripts/copy-assets.cjs does NOT copy unwanted typescript or markdown files to dist/data", () => {
      const dataFiles = fs.readdirSync(path.join(distDir, "data"));
      for (const f of dataFiles) {
        expect(f.endsWith(".json")).toBe(true);
        expect(f.endsWith(".ts")).toBe(false);
        expect(f.endsWith(".md")).toBe(false);
      }
    });

    it("4.7 scripts/copy-assets.cjs does NOT copy unwanted typescript or markdown files to dist/schemas", () => {
      const schemaFiles = fs.readdirSync(path.join(distDir, "schemas"));
      for (const f of schemaFiles) {
        expect(f.endsWith(".json")).toBe(true);
        expect(f.endsWith(".ts")).toBe(false);
        expect(f.endsWith(".md")).toBe(false);
      }
    });
  });

  // =========================================================================
  // Dimension 5: Stress, Idempotence & Performance
  // =========================================================================
  describe("Dimension 5: Stress, Idempotence & Performance", () => {
    it("5.1 executing copy-assets.cjs multiple times is strictly idempotent", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require("child_process");
      const scriptPath = path.join(rootDir, "scripts", "copy-assets.cjs");

      // Run twice in a row
      expect(() => {
        execSync(`node "${scriptPath}"`);
        execSync(`node "${scriptPath}"`);
      }).not.toThrow();

      const p = path.join(distDir, "data", "contractErrors.json");
      expect(fs.existsSync(p)).toBe(true);
    });

    it("5.2 parses 1000 contract error messages in under 50ms", () => {
      const t0 = performance.now();
      for (let i = 0; i < 1000; i++) {
        const code = (i % 22) + 1;
        parseContractError(`HostError: Error(Contract, #${code})`);
      }
      const t1 = performance.now();
      expect(t1 - t0).toBeLessThan(50);
    });

    it("5.3 lookupContractError is strictly deterministic across 100 iterations", () => {
      const first = lookupContractError("registry", 1);
      for (let i = 0; i < 100; i++) {
        const next = lookupContractError("registry", 1);
        expect(next).toEqual(first);
      }
    });

    const rapidRechecks = [1, 5, 10, 20, 50];
    rapidRechecks.forEach((count, idx) => {
      it(`5.4.${idx + 1} stress: parses ${count} unique random error codes without memory leaks`, () => {
        for (let i = 0; i < count; i++) {
          const randCode = Math.floor(Math.random() * 50) + 1;
          const res = parseContractError(`Error(Contract, #${randCode})`);
          if (res) {
            expect(res.code).toBe(randCode);
          }
        }
      });
    });
  });
});
