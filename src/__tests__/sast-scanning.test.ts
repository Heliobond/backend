import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

describe("SAST Scanning Configuration (Issue #285)", () => {
  describe("Security Audit Workflow", () => {
    const workflowPath = path.join(
      __dirname,
      "../../.github/workflows/security-audit.yml"
    );

    it("security-audit.yml workflow exists", () => {
      expect(fs.existsSync(workflowPath)).toBe(true);
    });

    it("workflow includes code vulnerability scan job", () => {
      const content = fs.readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);

      expect(workflow.jobs).toHaveProperty("code-vulnerability-scan");
    });

    it("workflow includes Trivy scanner for SAST", () => {
      const content = fs.readFileSync(workflowPath, "utf-8");
      
      expect(content).toContain("trivy");
      expect(content).toContain("scan-type: fs");
      expect(content).toContain("severity: CRITICAL,HIGH");
    });

    it("workflow fails on high/critical findings", () => {
      const content = fs.readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);

      const trivyStep = workflow.jobs["code-vulnerability-scan"]?.steps?.find(
        (step: { name?: string; uses?: string }) =>
          step.name?.includes("Trivy") || step.uses?.includes("trivy")
      );

      expect(trivyStep).toBeDefined();
      expect(trivyStep?.with?.["exit-code"]).toBe(1);
    });

    it("workflow includes secret detection with Gitleaks", () => {
      const content = fs.readFileSync(workflowPath, "utf-8");
      
      expect(content).toContain("gitleaks");
      expect(workflow.jobs).toHaveProperty("secret-detection");
    });

    it("SAST runs on scheduled basis", () => {
      const content = fs.readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);

      expect(workflow.on).toHaveProperty("schedule");
      expect(Array.isArray(workflow.on.schedule)).toBe(true);
      expect(workflow.on.schedule.length).toBeGreaterThan(0);
    });

    it("SAST can be manually triggered", () => {
      const content = fs.readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);

      expect(workflow.on).toHaveProperty("workflow_dispatch");
    });
  });

  describe("CI Workflow SAST Integration", () => {
    const ciWorkflowPath = path.join(
      __dirname,
      "../../.github/workflows/ci.yml"
    );

    it("CI workflow exists", () => {
      expect(fs.existsSync(ciWorkflowPath)).toBe(true);
    });

    it("CI includes dependency audit job", () => {
      const content = fs.readFileSync(ciWorkflowPath, "utf-8");
      const workflow = yaml.parse(content);

      expect(workflow.jobs).toHaveProperty("dependency-audit");
    });

    it("CI fails on high or critical vulnerabilities", () => {
      const content = fs.readFileSync(ciWorkflowPath, "utf-8");
      
      expect(content).toContain("npm audit --audit-level=high");
      expect(content).toContain("Fail on high or critical vulnerabilities");
    });
  });

  describe("SAST Results Visibility", () => {
    it("security-audit workflow has proper permissions for security events", () => {
      const workflowPath = path.join(
        __dirname,
        "../../.github/workflows/security-audit.yml"
      );
      const content = fs.readFileSync(workflowPath, "utf-8");
      const workflow = yaml.parse(content);

      expect(workflow.permissions).toBeDefined();
      expect(workflow.permissions["security-events"]).toBe("write");
      expect(workflow.permissions["contents"]).toBe("read");
    });

    it("workflow generates summary reports", () => {
      const workflowPath = path.join(
        __dirname,
        "../../.github/workflows/security-audit.yml"
      );
      const content = fs.readFileSync(workflowPath, "utf-8");
      
      // Check for GitHub step summary usage
      expect(content).toContain("GITHUB_STEP_SUMMARY");
    });

    it("workflow uploads audit artifacts", () => {
      const workflowPath = path.join(
        __dirname,
        "../../.github/workflows/security-audit.yml"
      );
      const content = fs.readFileSync(workflowPath, "utf-8");
      
      expect(content).toContain("actions/upload-artifact");
      expect(content).toContain("security-audit-report");
    });
  });
});
