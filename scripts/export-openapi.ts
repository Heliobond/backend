#!/usr/bin/env tsx
/**
 * Export OpenAPI specification to a JSON file.
 * This script is run at build time to ensure the spec file is always up to date.
 * Usage: bun run openapi:export
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiSpec } from "../src/lib/swagger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const outputPath = resolve(projectRoot, "openapi.json");

function main(): void {
  try {
    // Ensure the output directory exists
    mkdirSync(dirname(outputPath), { recursive: true });

    // Write the OpenAPI spec to the JSON file
    const json = JSON.stringify(openApiSpec, null, 2);
    writeFileSync(outputPath, json, "utf-8");

    console.log(`✅ OpenAPI spec exported to ${outputPath}`);
    console.log(`📝 Spec version: ${openApiSpec.info.version}`);
    console.log(`📋 Endpoints documented: ${Object.keys(openApiSpec.paths).length}`);
  } catch (error) {
    console.error("❌ Failed to export OpenAPI spec:", error);
    process.exit(1);
  }
}

main();
