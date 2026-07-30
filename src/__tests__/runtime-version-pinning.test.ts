import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("runtime version pinning (#207)", () => {
  describe("package.json engines", () => {
    const pkg = JSON.parse(read("package.json")) as {
      engines?: { node?: string; bun?: string };
    };

    it("declares an engines.node range", () => {
      expect(pkg.engines?.node).toBeDefined();
    });

    it("requires Node.js 20 or newer", () => {
      expect(pkg.engines?.node).toBe(">=20.0.0");
    });

    it("declares a bun range for the bun-based scripts", () => {
      expect(pkg.engines?.bun).toMatch(/^>=1\./);
    });
  });

  describe(".nvmrc", () => {
    it("exists", () => {
      expect(fs.existsSync(path.join(ROOT, ".nvmrc"))).toBe(true);
    });

    it("pins Node.js 20, matching engines and the Dockerfile", () => {
      expect(read(".nvmrc").trim()).toBe("20");
      expect(read("Dockerfile")).toContain("node:20-alpine");
    });
  });

  describe("CI workflows", () => {
    const workflows = ["ci.yml", "release.yml", "security-audit.yml"];

    it.each(workflows)("%s pins a bun-version for every setup-bun step", (workflow) => {
      const content = read(path.join(".github", "workflows", workflow));
      const setupSteps = content.match(/uses: oven-sh\/setup-bun@v\d+[\s\S]*?(?=\n\n|\n {6}- |$)/g);

      expect(setupSteps).not.toBeNull();
      for (const step of setupSteps ?? []) {
        expect(step).toMatch(/bun-version:\s*"1\.x"/);
      }
    });
  });
});
