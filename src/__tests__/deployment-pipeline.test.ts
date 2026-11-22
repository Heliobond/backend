/**
 * Tests for the deployment workflow (#226).
 *
 * Checks that the pipeline builds and publishes an image on push to main,
 * deploys to staging on merge, deploys to production on a release tag, and
 * reports status back through the GitHub Deployments API.
 */

import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";

const ROOT = path.resolve(__dirname, "../../");
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "deploy.yml");

const raw = fs.readFileSync(WORKFLOW_PATH, "utf8");

type Job = {
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  environment?: unknown;
  steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>;
};

// `on` is parsed by the YAML spec as the boolean true, so read it off the
// raw record rather than by name.
const workflow = parse(raw) as Record<string, unknown> & {
  jobs: Record<string, Job>;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
};

const triggers = (workflow.on ?? workflow[true as unknown as string]) as Record<string, unknown>;

function job(name: string): Job {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`Workflow has no job "${name}". Jobs: ${Object.keys(workflow.jobs)}`);
  return found;
}

function stepsOf(name: string): string {
  return JSON.stringify(job(name).steps ?? []);
}

describe("deployment workflow (#226)", () => {
  it("deploy.yml exists and parses", () => {
    expect(fs.existsSync(WORKFLOW_PATH)).toBe(true);
    expect(workflow.jobs).toBeDefined();
  });

  describe("triggers", () => {
    it("runs on push to main", () => {
      const push = triggers.push as { branches?: string[]; tags?: string[] };
      expect(push.branches).toContain("main");
    });

    it("runs on version tags", () => {
      const push = triggers.push as { tags?: string[] };
      expect(push.tags).toEqual(expect.arrayContaining([expect.stringMatching(/^v/)]));
    });

    it("runs when a release is published", () => {
      const release = triggers.release as { types?: string[] };
      expect(release.types).toContain("published");
    });

    it("accepts the repository_dispatch fired by release.yml", () => {
      const dispatch = triggers.repository_dispatch as { types?: string[] };
      expect(dispatch.types).toContain("deploy");

      // release.yml sends event_type=deploy; the two must stay in step.
      const release = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
      expect(release).toMatch(/event_type=deploy/);
    });

    it("can be run manually against either environment", () => {
      const manual = triggers.workflow_dispatch as {
        inputs?: { environment?: { options?: string[] } };
      };
      expect(manual.inputs?.environment?.options).toEqual(
        expect.arrayContaining(["staging", "production"]),
      );
    });
  });

  describe("environment routing", () => {
    const resolve = stepsOf("target");

    it("routes a plain push to main at staging", () => {
      expect(resolve).toMatch(/target=staging/);
    });

    it("routes releases and tags at production", () => {
      expect(resolve).toMatch(/release\|repository_dispatch\).*target=production/);
      expect(resolve).toMatch(/refs\/tags\/v\*/);
    });

    it("exposes the resolved environment to later jobs", () => {
      expect(job("target").outputs?.environment).toBeDefined();
    });
  });

  describe("image build and registry push", () => {
    const build = stepsOf("build-and-push");

    it("publishes to a container registry", () => {
      expect(workflow.env?.REGISTRY).toBe("ghcr.io");
      expect(build).toMatch(/docker\/login-action/);
    });

    it("authenticates with the built-in token", () => {
      expect(build).toMatch(/secrets\.GITHUB_TOKEN/);
      expect(workflow.permissions?.packages).toBe("write");
    });

    it("builds the production stage and pushes it", () => {
      expect(build).toMatch(/docker\/build-push-action/);
      expect(build).toMatch(/"target":\s*"production"/);
      expect(build).toMatch(/"push":\s*true/);
    });

    it("tags images by commit sha as well as by branch", () => {
      expect(build).toMatch(/type=sha/);
      expect(build).toMatch(/type=ref,event=branch/);
      expect(build).toMatch(/type=semver/);
    });

    it("exposes the image digest for the deploy job", () => {
      expect(job("build-and-push").outputs?.digest).toBeDefined();
    });
  });

  describe("deploy job", () => {
    const deploy = stepsOf("deploy");

    it("waits for the image before deploying", () => {
      expect(job("deploy").needs).toEqual(expect.arrayContaining(["build-and-push"]));
    });

    it("targets the resolved environment", () => {
      expect(JSON.stringify(job("deploy").environment)).toMatch(/target\.outputs\.environment/);
    });

    it("deploys the image by digest rather than by mutable tag", () => {
      expect(deploy).toMatch(/IMAGE_DIGEST/);
      expect(deploy).toMatch(/\$\{IMAGE_NAME\}@\$\{IMAGE_DIGEST\}/);
    });

    it("reads the deploy target from a secret", () => {
      expect(deploy).toMatch(/secrets\.DEPLOY_HOOK_URL/);
    });
  });

  describe("status reporting", () => {
    const deploy = stepsOf("deploy");

    it("has permission to write deployments", () => {
      expect(workflow.permissions?.deployments).toBe("write");
    });

    it("opens a deployment and marks it in_progress", () => {
      expect(deploy).toMatch(/createDeployment/);
      expect(deploy).toMatch(/in_progress/);
    });

    it("always closes the deployment with a final state", () => {
      expect(deploy).toMatch(/createDeploymentStatus/);
      expect(deploy).toMatch(/'success' : 'failure'/);
      expect(deploy).toMatch(/"if":\s*"always\(\)"/);
    });

    it("links the deployment back to the workflow run", () => {
      expect(deploy).toMatch(/log_url/);
      expect(deploy).toMatch(/context\.runId/);
    });
  });

  describe("safety", () => {
    it("does not cancel a deployment already in flight", () => {
      const concurrency = workflow.concurrency as { "cancel-in-progress"?: boolean };
      expect(concurrency["cancel-in-progress"]).toBe(false);
    });

    it("is documented", () => {
      const docs = fs.readFileSync(path.join(ROOT, "docs", "DEPLOYMENT.md"), "utf8");
      expect(docs).toMatch(/DEPLOY_HOOK_URL/);
      expect(docs).toMatch(/ghcr\.io/);
      expect(docs).toMatch(/staging/);
      expect(docs).toMatch(/production/);
    });
  });
});
