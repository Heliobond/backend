import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../");
const WORKFLOWS_DIR = path.join(ROOT, ".github", "workflows");

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8");
}

function workflowExists(name: string): boolean {
  return fs.existsSync(path.join(WORKFLOWS_DIR, name));
}

describe("deployment workflow tests (#284)", () => {
  describe("CI workflow (ci.yml)", () => {
    it("ci.yml exists", () => {
      expect(workflowExists("ci.yml")).toBe(true);
    });

    it("runs on push to main branch", () => {
      const content = readWorkflow("ci.yml");
      expect(content).toMatch(/on:/);
      expect(content).toMatch(/push:/);
      expect(content).toMatch(/branches.*main|main.*branches/s);
    });

    it("runs on pull_request to main", () => {
      const content = readWorkflow("ci.yml");
      expect(content).toMatch(/pull_request:/);
    });

    it("has a test job", () => {
      const content = readWorkflow("ci.yml");
      expect(content).toMatch(/test:/);
    });

    it("installs dependencies before running tests", () => {
      const content = readWorkflow("ci.yml");
      expect(content).toMatch(/install/i);
    });

    it("runs the test suite", () => {
      const content = readWorkflow("ci.yml");
      expect(content).toMatch(/bun run test|npm test|yarn test/);
    });

    it("builds the project", () => {
      const content = readWorkflow("ci.yml");
      expect(content).toMatch(/bun run build|npm run build|yarn build/);
    });

    it("uses concurrency to cancel in-progress runs", () => {
      const content = readWorkflow("ci.yml");
      expect(content).toMatch(/concurrency:/);
      expect(content).toMatch(/cancel-in-progress:\s*true/);
    });
  });

  describe("release workflow (release.yml)", () => {
    it("release.yml exists", () => {
      expect(workflowExists("release.yml")).toBe(true);
    });

    it("triggers on push to main or on release", () => {
      const content = readWorkflow("release.yml");
      expect(content).toMatch(/on:/);
      const triggersOnMain = /push:/.test(content) && /main/.test(content);
      const triggersOnRelease = /release:/.test(content) || /workflow_dispatch/.test(content);
      expect(triggersOnMain || triggersOnRelease).toBe(true);
    });
  });

  describe("Dockerfile", () => {
    const dockerfilePath = path.join(ROOT, "Dockerfile");

    it("Dockerfile exists", () => {
      expect(fs.existsSync(dockerfilePath)).toBe(true);
    });

    it("Dockerfile has a FROM instruction (base image)", () => {
      const content = fs.readFileSync(dockerfilePath, "utf8");
      expect(content).toMatch(/^FROM\s+\S+/m);
    });

    it("Dockerfile exposes a port", () => {
      const content = fs.readFileSync(dockerfilePath, "utf8");
      expect(content).toMatch(/EXPOSE\s+\d+/);
    });

    it("Dockerfile has a CMD or ENTRYPOINT", () => {
      const content = fs.readFileSync(dockerfilePath, "utf8");
      const hasCmd = /^CMD\s+/m.test(content);
      const hasEntrypoint = /^ENTRYPOINT\s+/m.test(content);
      expect(hasCmd || hasEntrypoint).toBe(true);
    });

    it("uses multi-stage build", () => {
      const content = fs.readFileSync(dockerfilePath, "utf8");
      const fromCount = (content.match(/^FROM\s+/gm) || []).length;
      expect(fromCount).toBeGreaterThanOrEqual(2);
    });

    it("production image runs on port 3001", () => {
      const content = fs.readFileSync(dockerfilePath, "utf8");
      expect(content).toMatch(/EXPOSE\s+3001/);
    });

    it("uses Node.js 20 base image", () => {
      const content = fs.readFileSync(dockerfilePath, "utf8");
      expect(content).toMatch(/FROM\s+node:20/);
    });

    it("Dockerfile copies package files before installing dependencies", () => {
      const content = fs.readFileSync(dockerfilePath, "utf8");
      expect(content).toMatch(/COPY.*package/i);
    });
  });

  describe("docker-compose.yml", () => {
    const composePath = path.join(ROOT, "docker-compose.yml");

    it("docker-compose.yml exists", () => {
      expect(fs.existsSync(composePath)).toBe(true);
    });

    it("defines at least one service", () => {
      const content = fs.readFileSync(composePath, "utf8");
      expect(content).toMatch(/services:/);
    });
  });

  describe("dependency audit workflow", () => {
    it("security-audit.yml includes a dependency audit job", () => {
      const content = readWorkflow("security-audit.yml");
      expect(content).toMatch(/dependency-audit/i);
    });

    it("audit runs npm audit or equivalent", () => {
      const content = readWorkflow("security-audit.yml");
      expect(content).toMatch(/npm audit|yarn audit|bun audit/);
    });
  });
});
