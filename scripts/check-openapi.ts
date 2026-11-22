#!/usr/bin/env tsx
/**
 * Check if the exported OpenAPI spec (openapi.json) is up to date with the source.
 * This script is used in CI to fail if the spec is stale.
 * Usage: bun run openapi:check
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiSpec } from "../src/lib/swagger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const specPath = resolve(projectRoot, "openapi.json");

function main(): void {
  if (!existsSync(specPath)) {
    console.error("❌ openapi.json not found. Run 'bun run openapi:export' first.");
    process.exit(1);
  }

  try {
    const fileContent = readFileSync(specPath, "utf-8");
    const exportedSpec = JSON.parse(fileContent);
    const currentSpec = openApiSpec;

    // Compare the two specs
    const exportedJson = JSON.stringify(exportedSpec, null, 2);
    const currentJson = JSON.stringify(currentSpec, null, 2);

    if (exportedJson === currentJson) {
      console.log("✅ OpenAPI spec is up to date");
      process.exit(0);
    } else {
      console.error("❌ OpenAPI spec is stale!");
      console.error(
        "   The exported openapi.json does not match the current spec in src/lib/swagger.ts",
      );
      console.error("   Run 'bun run openapi:export' to update it.");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Failed to check OpenAPI spec:", error);
    process.exit(1);
  }
}

main();
