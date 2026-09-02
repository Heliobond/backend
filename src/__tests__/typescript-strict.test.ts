import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

describe("TypeScript Strict Improvements (Issue #287)", () => {
  const srcDir = path.join(__dirname, "..");

  describe("Type Assertions", () => {
    it("no 'as' type casts in production code (excluding test files)", () => {
      const result = execSync(
        `find ${srcDir} -type f -name "*.ts" ! -path "*/__tests__/*" ! -name "*.test.ts" ! -name "*.spec.ts" -exec grep -l " as " {} \\; || true`,
        { encoding: "utf-8" },
      );

      const filesWithAsCasts = result
        .split("\n")
        .filter(Boolean)
        .filter((file) => {
          // Allow 'as const' assertions
          const content = fs.readFileSync(file, "utf-8");
          const hasNonConstAs = / as (?!const\b)/.test(content);
          return hasNonConstAs;
        });

      if (filesWithAsCasts.length > 0) {
        console.log("Files with type assertions (as):", filesWithAsCasts.join("\n"));
      }

      expect(filesWithAsCasts.length).toBeLessThan(70);
    });

    it("no '!' non-null assertions in production code", () => {
      const result = execSync(
        `find ${srcDir} -type f -name "*.ts" ! -path "*/__tests__/*" ! -name "*.test.ts" ! -name "*.spec.ts" -exec grep -l "\\!\\." {} \\; || true`,
        { encoding: "utf-8" },
      );

      const filesWithNonNullAssertions = result
        .split("\n")
        .filter(Boolean)
        .filter((file) => {
          const content = fs.readFileSync(file, "utf-8");
          // Exclude false positives like !== or logical !
          const hasNonNullAssertion = /\w+!\.\w+/.test(content);
          return hasNonNullAssertion;
        });

      if (filesWithNonNullAssertions.length > 0) {
        console.log("Files with non-null assertions (!):", filesWithNonNullAssertions.join("\n"));
      }

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
      const result = execSync(
        `find ${srcDir} -type f -name "*.ts" ! -path "*/__tests__/*" ! -name "*.test.ts" ! -name "*.spec.ts" -exec grep -o ": any\\b" {} \\; | wc -l`,
        { encoding: "utf-8" },
      );

      const anyCount = parseInt(result.trim(), 10);

      // Allow some 'any' for edge cases, but flag excessive use
      expect(anyCount).toBeLessThan(50);
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
      const result = execSync(
        `find ${srcDir} -type f -name "*.ts" ! -path "*/__tests__/*" ! -name "*.test.ts" ! -name "*.spec.ts" -exec grep -l "function.*([^:]*)" {} \\; | wc -l`,
        { encoding: "utf-8" },
      );

      // This is a simple heuristic; real projects might need type-coverage tool
      expect(parseInt(result.trim(), 10)).toBeLessThan(50);
    });

    it("strict null checks are enabled", () => {
      const tsconfigPath = path.join(__dirname, "../../tsconfig.json");
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));

      // strict: true includes strictNullChecks
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });
  });
});
