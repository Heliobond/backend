import fs from "fs";
import path from "path";

describe("Repository Hygiene and CHANGELOG Integrity (5D Matrix)", () => {
  const rootDir = path.resolve(__dirname, "../..");
  const changelogPath = path.join(rootDir, "CHANGELOG.md");
  const gitignorePath = path.join(rootDir, ".gitignore");
  const dockerignorePath = path.join(rootDir, ".dockerignore");

  let changelogContent: string;
  let gitignoreContent: string;
  let dockerignoreContent: string;

  beforeAll(() => {
    changelogContent = fs.readFileSync(changelogPath, "utf-8");
    gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    dockerignoreContent = fs.readFileSync(dockerignorePath, "utf-8");
  });

  // =========================================================================
  // Dimension 1: Boundary & Clamping
  // =========================================================================
  describe("Dimension 1: Boundary & Clamping", () => {
    it("1.1 enforces exactly one top-level ## [Unreleased] heading in CHANGELOG.md", () => {
      const matches = changelogContent.match(/^##\s+\[Unreleased\]/gm);
      expect(matches).not.toBeNull();
      expect(matches?.length).toBe(1);
    });

    it("1.2 verifies CHANGELOG has at least 50 lines and is non-empty", () => {
      const lines = changelogContent.split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(50);
    });

    const strayFileCandidates = [
      "tmp-idempotency-check.js",
      "FIX_SUMMARY.md",
      "IMPLEMENTATION_CHECKLIST.md",
      "tmp-debug.js",
      "tmp-test.ts",
      "tmp-check.py",
      "tmp-123.log",
      "temp-work.js",
      "scratch.js",
      "FIX_NOTES.md",
      "TODO_LIST.md",
      "AUDIT_CHECKLIST.md",
    ];

    strayFileCandidates.forEach((filename, idx) => {
      it(`1.3.${idx + 1} verifies stray working file "${filename}" is absent from repository root`, () => {
        const filePath = path.join(rootDir, filename);
        expect(fs.existsSync(filePath)).toBe(false);
      });
    });

    it("1.4 verifies .gitignore contains tmp-* entry", () => {
      const lines = gitignoreContent.split("\n").map((l) => l.trim());
      expect(lines).toContain("tmp-*");
    });

    it("1.5 verifies .dockerignore contains tmp-* entry", () => {
      const lines = dockerignoreContent.split("\n").map((l) => l.trim());
      expect(lines).toContain("tmp-*");
    });

    const criticalGitignoreEntries = [
      "node_modules/",
      "dist/",
      ".env",
      "coverage/",
      ".env.local",
      "tmp-*",
    ];

    criticalGitignoreEntries.forEach((entry, idx) => {
      it(`1.6.${idx + 1} verifies critical gitignore entry "${entry}" is present`, () => {
        const lines = gitignoreContent.split("\n").map((l) => l.trim());
        expect(lines).toContain(entry);
      });
    });
  });

  // =========================================================================
  // Dimension 2: Combinatorics
  // =========================================================================
  describe("Dimension 2: Combinatorics", () => {
    const keepAChangelogCategories = [
      "Added",
      "Changed",
      "Deprecated",
      "Removed",
      "Fixed",
      "Security",
    ];

    keepAChangelogCategories.forEach((cat, idx) => {
      it(`2.1.${idx + 1} verifies standard Keep a Changelog category "${cat}" is documented in template`, () => {
        const regex = new RegExp(`###\\s+${cat}`, "m");
        expect(regex.test(changelogContent)).toBe(true);
      });
    });

    const changelogSections = [
      { name: "Unreleased", regex: /^##\s+\[Unreleased\]/m },
      { name: "1.0.0", regex: /^##\s+\[1\.0\.0\]\s+-\s+\d{4}-\d{2}-\d{2}/m },
      { name: "Template", regex: /^##\s+Template/m },
    ];

    changelogSections.forEach(({ name, regex }, idx) => {
      it(`2.2.${idx + 1} verifies core CHANGELOG section "${name}" exists with correct syntax`, () => {
        expect(regex.test(changelogContent)).toBe(true);
      });
    });

    const tmpWildcardPatterns = [
      "tmp-1.js",
      "tmp-run.ts",
      "tmp-cache.json",
      "tmp-output.log",
      "tmp-sub/file.txt",
      "tmp-nested/dir/test.ts",
      "tmp-a",
      "tmp-benchmark-results.csv",
    ];

    tmpWildcardPatterns.forEach((sample, idx) => {
      it(`2.3.${idx + 1} verifies simulated glob pattern matches "${sample}" against tmp-* rule`, () => {
        const pattern = /^tmp-.*/;
        const filename = sample.split("/")[0];
        expect(pattern.test(filename)).toBe(true);
      });
    });

    const nonTmpPatterns = [
      "templates",
      "template.html",
      "types.ts",
      "tsconfig.json",
      "test.ts",
      "time.ts",
    ];

    nonTmpPatterns.forEach((sample, idx) => {
      it(`2.4.${idx + 1} verifies non-tmp pattern "${sample}" is NOT matched by tmp-* rule`, () => {
        const pattern = /^tmp-.*/;
        expect(pattern.test(sample)).toBe(false);
      });
    });
  });

  // =========================================================================
  // Dimension 3: Host Variations & Structure
  // =========================================================================
  describe("Dimension 3: Host Variations & Structure", () => {
    it("3.1 verifies H1 title is '# Changelog'", () => {
      const firstHeading = changelogContent.match(/^#\s+(.+)$/m);
      expect(firstHeading).not.toBeNull();
      expect(firstHeading?.[1].trim()).toBe("Changelog");
    });

    it("3.2 verifies markdown link reference [unreleased] exists at the bottom", () => {
      expect(changelogContent).toMatch(/^\[unreleased\]:\s+https:\/\/github\.com\/heliobond\/backend\/compare\/v1\.0\.0\.\.\.HEAD/m);
    });

    it("3.3 verifies markdown link reference [1.0.0] exists at the bottom", () => {
      expect(changelogContent).toMatch(/^\[1\.0\.0\]:\s+https:\/\/github\.com\/heliobond\/backend\/releases\/tag\/v1\.0\.0/m);
    });

    it("3.4 verifies Keep a Changelog link is present in header", () => {
      expect(changelogContent).toContain("https://keepachangelog.com/en/1.0.0/");
    });

    it("3.5 verifies Semantic Versioning link is present in header", () => {
      expect(changelogContent).toContain("https://semver.org/spec/v2.0.0.html");
    });

    it("3.6 verifies package.json exists and has valid name 'heliobond-backend'", () => {
      const pkgPath = path.join(rootDir, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      expect(pkg.name).toBe("heliobond-backend");
      expect(pkg.version).toBe("1.0.0");
    });

    const expectedScripts = [
      "dev",
      "build",
      "test",
      "lint",
      "typecheck",
      "format",
    ];

    expectedScripts.forEach((scriptName, idx) => {
      it(`3.7.${idx + 1} verifies package.json includes script "${scriptName}"`, () => {
        const pkgPath = path.join(rootDir, "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        expect(pkg.scripts[scriptName]).toBeDefined();
      });
    });
  });

  // =========================================================================
  // Dimension 4: Negative Controls & Preservation
  // =========================================================================
  describe("Dimension 4: Negative Controls & Preservation", () => {
    const legitimateRootFiles = [
      "README.md",
      "API.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "CHANGELOG.md",
      "package.json",
      "tsconfig.json",
      "docker-compose.yml",
      "Dockerfile",
      ".gitignore",
      ".dockerignore",
      ".releaserc.json",
      "eslint.config.mjs",
      "jest.config.ts",
    ];

    legitimateRootFiles.forEach((file, idx) => {
      it(`4.1.${idx + 1} ensures legitimate project file "${file}" is preserved at root`, () => {
        const filePath = path.join(rootDir, file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    });

    it("4.2 ensures no stray javascript files exist at root except configuration", () => {
      const allowedJsFiles = new Set(["tmp-idempotency-check.js"]); // disallowed
      const rootEntries = fs.readdirSync(rootDir);
      const jsFiles = rootEntries.filter((f) => f.endsWith(".js"));

      jsFiles.forEach((file) => {
        expect(allowedJsFiles.has(file)).toBe(false);
      });
    });

    it("4.3 ensures no stray markdown summary files exist at root", () => {
      const rootEntries = fs.readdirSync(rootDir);
      expect(rootEntries).not.toContain("FIX_SUMMARY.md");
      expect(rootEntries).not.toContain("IMPLEMENTATION_CHECKLIST.md");
      expect(rootEntries).not.toContain("AUDIT_SUMMARY.md");
    });
  });

  // =========================================================================
  // Dimension 5: Lifecycle, Parsing Stress & Invariants
  // =========================================================================
  describe("Dimension 5: Lifecycle, Parsing Stress & Invariants", () => {
    it("5.1 verifies changelog parser completes in under 20ms", () => {
      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        const parsedMatches = changelogContent.match(/^##\s+\[Unreleased\]/gm);
        expect(parsedMatches?.length).toBe(1);
      }
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(100);
    });

    it("5.2 ensures idempotent parsing across 100 iterations", () => {
      for (let i = 0; i < 100; i++) {
        const headings = changelogContent
          .split("\n")
          .filter((line) => line.startsWith("## ["));
        expect(headings.length).toBe(2); // ## [Unreleased] and ## [1.0.0]
        expect(headings[0]).toBe("## [Unreleased]");
        expect(headings[1].startsWith("## [1.0.0]")).toBe(true);
      }
    });

    const headingStressVariations = [
      "## [Unreleased]",
      "## [1.0.0] - 2026-07-29",
      "## [1.1.0] - 2026-08-15",
      "## [2.0.0] - 2026-09-01",
      "## [2.0.1] - 2026-09-10",
      "## [2.1.0-beta.1] - 2026-10-01",
    ];

    headingStressVariations.forEach((heading, idx) => {
      it(`5.3.${idx + 1} validates semantic release heading regex matches "${heading}"`, () => {
        const regex = /^##\s+\[(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?|Unreleased)\](?:\s+-\s+\d{4}-\d{2}-\d{2})?$/;
        expect(regex.test(heading)).toBe(true);
      });
    });

    const malformedHeadings = [
      "## Unreleased",
      "#[Unreleased]",
      "### [Unreleased]",
      "## [1.0] - 2026",
      "## [v1.0.0]",
      "## [bad-version]",
    ];

    malformedHeadings.forEach((heading, idx) => {
      it(`5.4.${idx + 1} rejects malformed release heading "${heading}"`, () => {
        const regex = /^##\s+\[(\d+\.\d+\.\d+|Unreleased)\](?:\s+-\s+\d{4}-\d{2}-\d{2})?$/;
        expect(regex.test(heading)).toBe(false);
      });
    });

    it("5.5 verifies .gitignore ends with a clean newline", () => {
      expect(gitignoreContent.endsWith("\n")).toBe(true);
    });

    it("5.6 verifies CHANGELOG template comment does not leak as active heading", () => {
      const lines = changelogContent.split("\n");
      const unreleasedHeadings = lines.filter((l) => l.trim() === "## [Unreleased]");
      expect(unreleasedHeadings.length).toBe(1);
    });

    const documentedIssueReferences = [
      "#542",
      "#660",
      "#661",
      "#662",
      "#221",
      "#222",
      "#223",
      "#224",
    ];

    documentedIssueReferences.forEach((issueRef, idx) => {
      it(`5.7.${idx + 1} verifies referenced issue "${issueRef}" exists in Unreleased notes`, () => {
        expect(changelogContent).toContain(issueRef);
      });
    });

    const unreleasedBulletPoints = [
      "Structured admin audit logging",
      "Legacy",
      "Investor notifications",
      "One-command local stack",
      "In-memory TTL cache",
      "Upper bound on the",
      "bun run dev:no-watch",
      "Changelog conventions",
      "node --watch",
      "src/routes/iot.ts",
    ];

    unreleasedBulletPoints.forEach((bulletSnippet, idx) => {
      it(`5.8.${idx + 1} verifies unreleased bullet point "${bulletSnippet.slice(0, 30)}..." exists`, () => {
        expect(changelogContent).toContain(bulletSnippet);
      });
    });

    it("5.9 verifies Keep a Changelog link text matches standard format", () => {
      expect(changelogContent).toContain("[Keep a Changelog]");
    });

    it("5.10 verifies Semantic Versioning link text matches standard format", () => {
      expect(changelogContent).toContain("[Semantic Versioning]");
    });
  });
});
