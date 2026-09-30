#!/usr/bin/env tsx
/**
 * Generate the API client package from the OpenAPI spec.
 * This creates TypeScript types and a fetch client using openapi-typescript and openapi-fetch.
 * Usage: bun run api-client:generate
 */

import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const specPath = resolve(projectRoot, "openapi.json");
const clientPackageRoot = resolve(projectRoot, "packages/api-client");
const clientSrcDir = resolve(clientPackageRoot, "src");
const clientTypesPath = resolve(clientSrcDir, "types.ts");
const clientIndexPath = resolve(clientSrcDir, "index.ts");
const clientPackageJsonPath = resolve(clientPackageRoot, "package.json");
const clientTsconfigPath = resolve(clientPackageRoot, "tsconfig.json");

function runCommand(cmd: string, cwd: string = projectRoot): void {
  console.log(`🔧 Running: ${cmd}`);
  try {
    execSync(cmd, { cwd, stdio: "inherit" });
  } catch (error) {
    console.error(`❌ Command failed: ${cmd}`);
    throw error;
  }
}

function main(): void {
  try {
    // Ensure the spec exists
    if (!existsSync(specPath)) {
      console.error("❌ openapi.json not found. Run 'npm run openapi:export' first.");
      process.exit(1);
    }

    // Clean and create the client package directory
    if (existsSync(clientPackageRoot)) {
      rmSync(clientPackageRoot, { recursive: true, force: true });
    }
    mkdirSync(clientSrcDir, { recursive: true });

    console.log("📦 Generating API client package...");

    // Generate TypeScript types using openapi-typescript
    console.log("🔄 Generating TypeScript types...");
    runCommand(`bunx openapi-typescript ${specPath} -o ${clientTypesPath}`, projectRoot);

    // Create the main index.ts that exports the client
    const indexContent = `/**
 * Heliobond API Client
 * Auto-generated from OpenAPI spec. Do not edit manually.
 * Run 'bun run api-client:generate' in the backend to regenerate.
 */

import type { paths } from "./types.js";
import createClient, { type Middleware, type Client } from "openapi-fetch";

/**
 * Configuration options for the API client
 */
export interface ApiClientConfig {
  /** Base URL of the API (e.g., 'https://api.heliobond.com/v1') */
  baseUrl: string;
  /** Optional middleware for request/response interception */
  middleware?: Middleware[];
  /** Default headers to include with every request */
  headers?: Record<string, string>;
}

/**
 * Create a typed API client for the Heliobond backend
 * @param config - Client configuration
 * @returns Typed fetch client with full TypeScript support
 */
export function createApiClient(config: ApiClientConfig): Client<paths> {
  const client = createClient<paths>({
    baseUrl: config.baseUrl,
    headers: config.headers,
  });

  if (config.middleware) {
    config.middleware.forEach((mw) => client.use(mw));
  }

  return client;
}

/**
 * Default export for convenience
 */
export default createApiClient;

/**
 * Re-export types for consumers
 */
export type { paths } from "./types.js";
`;

    writeFileSync(clientIndexPath, indexContent, "utf-8");

    // Create package.json for the client package. The version follows the spec.
    const specVersion = JSON.parse(readFileSync(specPath, "utf-8")).info.version as string;
    const packageJson = {
      name: "@heliobond/api-client",
      version: specVersion,
      description: "Type-safe API client for Heliobond backend",
      license: "Apache-2.0",
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          default: "./dist/index.js",
        },
      },
      files: ["dist"],
      scripts: {
        build: "tsc",
        prepublishOnly: "npm run build",
      },
      peerDependencies: {
        "openapi-fetch": "^0.13.0",
      },
      devDependencies: {
        typescript: "^6.0.3",
        "openapi-fetch": "^0.13.0",
      },
      publishConfig: {
        registry: "https://npm.pkg.github.com/",
        access: "restricted",
      },
      repository: {
        type: "git",
        url: "https://github.com/heliobond/backend.git",
        directory: "packages/api-client",
      },
    };

    writeFileSync(clientPackageJsonPath, JSON.stringify(packageJson, null, 2), "utf-8");

    // Create tsconfig.json for the client package
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022"],
        outDir: "./dist",
        rootDir: "./src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: false,
      },
      include: ["src/**/*"],
      exclude: ["node_modules", "dist"],
    };

    writeFileSync(clientTsconfigPath, JSON.stringify(tsconfig, null, 2), "utf-8");

    // Create README for the client package
    const readme = `# @heliobond/api-client

Type-safe API client for the Heliobond backend, generated from the OpenAPI specification.

## Installation

\`\`\`bash
npm install @heliobond/api-client openapi-fetch
\`\`\`

## Usage

\`\`\`typescript
import { createApiClient } from "@heliobond/api-client";

const api = createApiClient({
  baseUrl: "https://api.heliobond.com/v1",
  headers: {
    "X-User-Id": "user-123", // For admin endpoints
  },
});

// Fully typed API calls
const projects = await api.GET("/projects");
const project = await api.GET("/projects/{id}", { params: { path: { id: 1 } } });
const portfolio = await api.GET("/portfolio");
\`\`\`

## Regenerating

This package is auto-generated from the backend's OpenAPI spec. To regenerate:

1. In the backend repo: \`bun run openapi:export\`
2. Then: \`bun run api-client:generate\`
3. Then: \`bun run api-client:build\`
4. Then: \`bun run api-client:publish\` (requires npm auth)

## Versioning

The client version follows the backend's OpenAPI spec version (info.version).
`;

    writeFileSync(resolve(clientPackageRoot, "README.md"), readme, "utf-8");

    // Match the repo's formatting so regenerated files are byte-identical to committed ones.
    runCommand(`bunx prettier --write "${clientSrcDir}/*.ts"`, projectRoot);

    console.log("✅ API client package generated at packages/api-client");
    console.log("📝 Next: bun run api-client:build");
  } catch (error) {
    console.error("❌ Failed to generate API client:", error);
    process.exit(1);
  }
}

main();
