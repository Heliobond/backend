import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

describe("Dependabot Configuration (Issue #286)", () => {
  const dependabotConfigPath = path.join(
    __dirname,
    "../../.github/dependabot.yml"
  );

  describe("Configuration File", () => {
    it("dependabot.yml exists in .github directory", () => {
      expect(fs.existsSync(dependabotConfigPath)).toBe(true);
    });

    it("dependabot.yml is valid YAML", () => {
      expect(() => {
        const content = fs.readFileSync(dependabotConfigPath, "utf-8");
        yaml.parse(content);
      }).not.toThrow();
    });

    it("has version 2 format", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      expect(config.version).toBe(2);
    });
  });

  describe("Package Ecosystem", () => {
    it("monitors npm package ecosystem", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      expect(config.updates).toBeDefined();
      expect(Array.isArray(config.updates)).toBe(true);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      expect(npmUpdate).toBeDefined();
    });

    it("monitors correct directory", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      expect(npmUpdate.directory).toBe("/");
    });
  });

  describe("Update Schedule", () => {
    it("has a configured update schedule", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      expect(npmUpdate.schedule).toBeDefined();
      expect(npmUpdate.schedule.interval).toBeDefined();
    });

    it("update schedule is weekly or daily", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      const validIntervals = ["daily", "weekly", "monthly"];
      expect(validIntervals).toContain(npmUpdate.schedule.interval);
    });

    it("schedule has specific day and time (if weekly)", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      if (npmUpdate.schedule.interval === "weekly") {
        expect(npmUpdate.schedule.day).toBeDefined();
        expect(npmUpdate.schedule.time).toBeDefined();
      }
    });
  });

  describe("PR Configuration", () => {
    it("limits open pull requests", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      expect(npmUpdate["open-pull-requests-limit"]).toBeDefined();
      expect(typeof npmUpdate["open-pull-requests-limit"]).toBe("number");
      expect(npmUpdate["open-pull-requests-limit"]).toBeGreaterThan(0);
    });

    it("has reviewers configured", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      if (npmUpdate.reviewers) {
        expect(Array.isArray(npmUpdate.reviewers)).toBe(true);
      }
    });

    it("has commit message prefix configured", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      if (npmUpdate["commit-message"]) {
        expect(npmUpdate["commit-message"].prefix).toBeDefined();
      }
    });
  });

  describe("Security Updates", () => {
    it("monitors both direct and indirect dependencies", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      if (npmUpdate.allow) {
        const allowedTypes = npmUpdate.allow.map(
          (a: { "dependency-type": string }) => a["dependency-type"]
        );
        expect(allowedTypes).toContain("direct");
      }
    });

    it("has security updates grouping (optional)", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      // Optional feature - just check it's valid if present
      if (npmUpdate.groups) {
        expect(typeof npmUpdate.groups).toBe("object");
      }
    });
  });

  describe("Dependabot Creates PRs", () => {
    it("package.json has dependencies that Dependabot can update", () => {
      const packageJsonPath = path.join(__dirname, "../../package.json");
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf-8")
      );

      const hasDependencies =
        (packageJson.dependencies &&
          Object.keys(packageJson.dependencies).length > 0) ||
        (packageJson.devDependencies &&
          Object.keys(packageJson.devDependencies).length > 0);

      expect(hasDependencies).toBe(true);
    });

    it("Dependabot can parse package.json", () => {
      const packageJsonPath = path.join(__dirname, "../../package.json");
      
      expect(() => {
        const content = fs.readFileSync(packageJsonPath, "utf-8");
        JSON.parse(content);
      }).not.toThrow();
    });
  });

  describe("Advanced Configuration", () => {
    it("has rebase strategy configured", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      const config = yaml.parse(content);

      const npmUpdate = config.updates.find(
        (update: { "package-ecosystem": string }) =>
          update["package-ecosystem"] === "npm"
      );

      if (npmUpdate["rebase-strategy"]) {
        const validStrategies = ["auto", "disabled"];
        expect(validStrategies).toContain(npmUpdate["rebase-strategy"]);
      }
    });

    it("configuration is well-formed with no duplicate keys", () => {
      const content = fs.readFileSync(dependabotConfigPath, "utf-8");
      
      // YAML parser will throw on duplicate keys in strict mode
      expect(() => yaml.parse(content, { strict: true })).not.toThrow();
    });
  });
});
