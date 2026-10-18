#!/usr/bin/env node
/**
 * Copies JSON assets and schemas from src/ into dist/ after compilation.
 * Ensures production runtime can import JSON modules without MODULE_NOT_FOUND.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");

function copyDirJson(srcSub, distSub) {
  const src = path.join(srcDir, srcSub);
  const dest = path.join(distDir, distSub);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const stat = fs.statSync(source);
      if (stat.isDirectory()) return true;
      return source.endsWith(".json");
    },
  });
}

function main() {
  copyDirJson("data", "data");
  copyDirJson("schemas", "schemas");
  copyDirJson("config", "config");
}

main();
