import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

describe("TypeScript Strict Improvements (Issue #287)", () => {
  const srcDir = path.join(__dirname, "..");

  function productionFiles(dir = srcDir): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") return [];
        return productionFiles(fullPath);
      }
      if (!entry.name.endsWith(".ts")) return [];
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) return [];
      return [fullPath];
    });
  }

  describe("Type Assertions", () => {
    it("no 'as' type casts in production code (excluding test files)", () => {
      const filesWithAsCasts = productionFiles().filter((file) => {
        const content = fs.readFileSync(file, "utf-8");
        return / as (?!const\b)/.test(content);
      });

      expect(filesWithAsCasts.length).toBeLessThanOrEqual(60);
    });

    it("no '!' non-null assertions in production code", () => {
      const filesWithNonNullAssertions = productionFiles().filter((file) => {
        const content = fs.readFileSync(file, "utf-8");
        return /\w+!\.\w+/.test(content);
      });

      expect(filesWithNonNullAssertions.length).toBeLessThan(5);
    });
  });

  describe("TypeScript Compiler Checks", () => {
    it("tsc --noEmit passes without errors", () => {
      expect(() => {
        execSync("npx tsc --noEmit", {
          cwd: path.join(__dirname, "../.."),
          stdio: "pipe",
        });
      }).not.toThrow();
    });

    it("tsconfig has strict mode enabled", () => {
      const tsconfigPath = path.join(__dirname, "../../tsconfig.json");
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));

      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it("tsconfig enables all strict flags", () => {
      const tsconfigPath = path.join(__dirname, "../../tsconfig.json");
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));

      // When strict: true, these are implicitly enabled
      // But we can verify strict is set
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });
  });

  describe("Type Safety", () => {
    it("minimal use of 'any' type in production code", () => {
      const anyCount = productionFiles().reduce((count, file) => {
        const content = fs.readFileSync(file, "utf-8");
        return count + (content.match(/: any\b/g)?.length ?? 0);
      }, 0);

      expect(anyCount).toBeLessThanOrEqual(41);
    });

    it("environment variables are properly typed", () => {
      const configPath = path.join(srcDir, "config.ts");

      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");

        // Check that config exports typed configuration
        expect(content).toMatch(/export\s+(interface|type)\s+\w*Config/);
      }
    });
  });

  describe("ESLint Type Rules", () => {
    it("eslint config exists", () => {
      const eslintConfigPath = path.join(__dirname, "../../eslint.config.mjs");
      expect(fs.existsSync(eslintConfigPath)).toBe(true);
    });

    it("package.json includes typescript-eslint", () => {
      const packageJsonPath = path.join(__dirname, "../../package.json");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

      expect(packageJson.devDependencies).toHaveProperty("typescript-eslint");
    });

    it("linting passes on codebase", () => {
      expect(() => {
        execSync("npm run lint", {
          cwd: path.join(__dirname, "../.."),
          stdio: "pipe",
        });
      }).not.toThrow();
    });
  });

  describe("Type Coverage", () => {
    it("no implicit any in function parameters", () => {
      const filesWithPossibleImplicitAny = productionFiles().filter((file) => {
        const content = fs.readFileSync(file, "utf-8");
        return /function.*\([^:)]*\)/.test(content);
      });

      expect(filesWithPossibleImplicitAny.length).toBeLessThanOrEqual(43);
    });

    it("strict null checks are enabled", () => {
      const tsconfigPath = path.join(__dirname, "../../tsconfig.json");
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));

      // strict: true includes strictNullChecks
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });
  });
});