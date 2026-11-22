import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";

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

    it("cancels superseded PR runs while allowing main releases to finish", () => {
      expect(parse(readWorkflow("ci.yml")).concurrency["cancel-in-progress"]).toBe(
        "${{ github.event_name == 'pull_request' }}",
      );
    });
  });

  describe("release workflow (release.yml)", () => {
    it("release.yml exists", () => {
      expect(workflowExists("release.yml")).toBe(true);
    });

    const ci = parse(readWorkflow("ci.yml"));
    const release = parse(readWorkflow("release.yml"));
    const writePermissions = { contents: "write", issues: "write", "pull-requests": "write" };

    it("calls release only after successful validation on a canonical main push", () => {
      expect(ci.jobs.test.needs).toBe("security-gates");
      expect(ci.jobs.release).toEqual({
        needs: "test",
        if:
          "github.event_name == 'push' && github.repository == 'Heliobond/backend' && " +
          "github.ref == 'refs/heads/main' && needs.test.result == 'success'",
        uses: "./.github/workflows/release.yml",
        permissions: writePermissions,
      });
      expect(Object.keys(release.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    });

    it("requires successful manual validation, and excludes cancelled or untrusted publication", () => {
      expect(release.jobs["build-test"].if).toBe("github.event_name == 'workflow_dispatch'");
      expect(release.jobs.release.needs).toBe("build-test");
      expect(release.jobs.release.if).toBe(
        "!cancelled() && github.repository == 'Heliobond/backend' && " +
          "((github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.build-test.result == 'skipped') || " +
          "(github.event_name == 'workflow_dispatch' && needs.build-test.result == 'success'))",
      );
      expect(release.jobs.release.permissions).toEqual(writePermissions);
    });

    it("builds and tests the exact release SHA with read-only permissions", () => {
      for (const job of [ci.jobs.test, release.jobs["build-test"]]) {
        expect(job.permissions).toEqual({ contents: "read" });
        expect(job.steps[0].uses).toMatch(/^actions\/checkout@/);
        expect(job.steps[0].with).toEqual({
          ref: "${{ github.sha }}",
          "persist-credentials": false,
        });
        expect(job.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ run: "bun run build" }),
            expect.objectContaining({ run: "bun run test" }),
          ]),
        );
      }
      expect(release.jobs.release.steps[0].uses).toMatch(/^actions\/checkout@/);
      expect(release.jobs.release.steps[0].with.ref).toBe("${{ github.sha }}");
    });
  });

  describe("protected-branch releases", () => {
    it("uses GitHub release notes without plugins that prepare repository commits", () => {
      const config = JSON.parse(fs.readFileSync(path.join(ROOT, ".releaserc.json"), "utf8"));
      const plugins = config.plugins.map((plugin: string | [string, unknown]) =>
        typeof plugin === "string" ? plugin : plugin[0],
      );
      expect(plugins).toContain("@semantic-release/github");
      expect(plugins).not.toContain("@semantic-release/git");
      expect(plugins).not.toContain("@semantic-release/changelog");
      expect(plugins).not.toContain("@semantic-release/npm");
    });

    it("pushes only the selected manual release tag", () => {
      const workflow = readWorkflow("release.yml");
      expect(workflow).toContain('git push origin "refs/tags/v${VERSION}"');
      expect(workflow).not.toMatch(/git push[^\n]*HEAD|git commit/);
      expect(workflow).toContain('npm version "${CURRENT_VERSION#v}"');
      expect(workflow).toContain("git tag --merged HEAD --sort=-version:refname");
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
