/**
 * Tests for container resource limits (#225).
 *
 * Verifies the memory and CPU ceilings, the V8 heap ceiling, and that the heap
 * ceiling leaves headroom below the container memory limit.
 */

import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";

const ROOT = path.resolve(__dirname, "../../");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Convert a Compose memory string ("512M", "1g", "268435456") to bytes. */
function toBytes(value: string | number): number {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*([kmgKMG])?[bB]?$/.exec(value.trim());
  if (!match) throw new Error(`Unparseable memory value: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] || "").toLowerCase();
  const multiplier = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
  return amount * multiplier;
}

const MB = 1024 * 1024;

type ComposeService = {
  environment?: string[];
  command?: string[];
  deploy?: {
    resources?: {
      limits?: { cpus?: string; memory?: string };
      reservations?: { cpus?: string; memory?: string };
    };
  };
};

const compose = parse(read("docker-compose.yml")) as {
  services: Record<string, ComposeService>;
};
const dockerfile = read("Dockerfile");

function limitsFor(service: string) {
  const limits = compose.services[service]?.deploy?.resources?.limits;
  if (!limits) throw new Error(`No deploy.resources.limits for service "${service}"`);
  return limits;
}

describe("container resource limits (#225)", () => {
  describe("backend service", () => {
    it("declares a memory limit", () => {
      const { memory } = limitsFor("backend");
      expect(memory).toBeDefined();
      expect(toBytes(memory!)).toBeGreaterThan(0);
    });

    it("caps memory at 512MB", () => {
      expect(toBytes(limitsFor("backend").memory!)).toBe(512 * MB);
    });

    it("declares a CPU limit of half a core", () => {
      expect(Number(limitsFor("backend").cpus)).toBe(0.5);
    });

    it("reserves less than it limits", () => {
      const resources = compose.services.backend.deploy!.resources!;
      expect(toBytes(resources.reservations!.memory!)).toBeLessThan(
        toBytes(resources.limits!.memory!),
      );
      expect(Number(resources.reservations!.cpus)).toBeLessThan(Number(resources.limits!.cpus));
    });
  });

  describe("Node.js heap ceiling", () => {
    it("sets --max-old-space-size in the production image", () => {
      const productionStage = dockerfile.slice(dockerfile.indexOf("AS production"));
      expect(productionStage).toMatch(/NODE_OPTIONS=.*--max-old-space-size=\d+/);
    });

    it("sets it to 384MB", () => {
      const match = /--max-old-space-size=(\d+)/.exec(dockerfile);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBe(384);
    });

    it("does not set it in the build stage", () => {
      const buildStage = dockerfile.slice(0, dockerfile.indexOf("AS production"));
      expect(buildStage).not.toMatch(/max-old-space-size/);
    });

    it("leaves headroom below the container memory limit", () => {
      const heapMb = Number(/--max-old-space-size=(\d+)/.exec(dockerfile)![1]);
      const limitMb = toBytes(limitsFor("backend").memory!) / MB;

      // V8 old space does not account for the Node binary, native buffers or
      // thread stacks, so the ceiling must sit meaningfully below the limit.
      expect(heapMb).toBeLessThan(limitMb);
      expect(limitMb - heapMb).toBeGreaterThanOrEqual(64);
    });

    it("passes the same ceiling through compose", () => {
      const environment = compose.services.backend.environment ?? [];
      expect(environment).toEqual(
        expect.arrayContaining([expect.stringContaining("--max-old-space-size=384")]),
      );
    });
  });

  describe("documentation", () => {
    const docPath = path.join(ROOT, "docs", "DEPLOYMENT.md");

    it("deployment docs exist", () => {
      expect(fs.existsSync(docPath)).toBe(true);
    });

    it("documents the resource requirements", () => {
      const content = fs.readFileSync(docPath, "utf8");
      expect(content).toMatch(/512 ?MB/i);
      expect(content).toMatch(/0\.5/);
      expect(content).toMatch(/max-old-space-size=384/);
    });
  });
});
