/**
 * Tests for the type assertions replaced with runtime validation (#228).
 *
 * Covers the three sites named in the issue:
 *   - config.ts        STELLAR_NETWORK  (was `as "testnet" | "mainnet"`)
 *   - lib/registry.ts  sim.result       (was `sim.result!`)
 *   - routes/admin.ts  project_ids      (was `raw as number[]`)
 */

import * as fs from "fs";
import * as path from "path";

import { isStellarNetwork, STELLAR_NETWORKS } from "../config";

const SRC_DIR = path.join(__dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_DIR, relativePath), "utf8");
}

describe("STELLAR_NETWORK validation (#228)", () => {
  it("accepts only the two supported networks", () => {
    expect(isStellarNetwork("testnet")).toBe(true);
    expect(isStellarNetwork("mainnet")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of ["", "TESTNET", "futurenet", "main", "testnet ", "public"]) {
      expect(isStellarNetwork(value)).toBe(false);
    }
  });

  it("exposes the allowed values used for the startup error message", () => {
    expect([...STELLAR_NETWORKS]).toEqual(["testnet", "mainnet"]);
  });

  it("coerces an unrecognised value to the default instead of trusting it", () => {
    const originalEnv = process.env.STELLAR_NETWORK;
    process.env.STELLAR_NETWORK = "not-a-network";
    jest.resetModules();
    try {
      const fresh = jest.requireActual<typeof import("../config")>("../config");
      expect(fresh.config.STELLAR_NETWORK).toBe("testnet");
      expect(isStellarNetwork(fresh.config.STELLAR_NETWORK)).toBe(true);
    } finally {
      if (originalEnv === undefined) delete process.env.STELLAR_NETWORK;
      else process.env.STELLAR_NETWORK = originalEnv;
      jest.resetModules();
    }
  });

  it("validateRequiredEnv rejects an invalid network value", () => {
    const original = { ...process.env };
    process.env.ADMIN_SECRET_KEY = "test-secret-key";
    process.env.PROJECT_REGISTRY_CONTRACT_ID = "C1234567890";
    process.env.STELLAR_NETWORK = "futurenet";
    try {
      const { validateRequiredEnv } = jest.requireActual<typeof import("../config")>("../config");
      expect(() => validateRequiredEnv()).toThrow(/STELLAR_NETWORK/);
      expect(() => validateRequiredEnv()).toThrow(/testnet, mainnet/);
    } finally {
      process.env = original;
    }
  });

  it("validateRequiredEnv accepts both valid network values", () => {
    const original = { ...process.env };
    process.env.ADMIN_SECRET_KEY = "test-secret-key";
    process.env.PROJECT_REGISTRY_CONTRACT_ID = "C1234567890";
    try {
      const { validateRequiredEnv } = jest.requireActual<typeof import("../config")>("../config");
      for (const network of ["testnet", "mainnet"]) {
        process.env.STELLAR_NETWORK = network;
        expect(() => validateRequiredEnv()).not.toThrow();
      }
    } finally {
      process.env = original;
    }
  });
});

describe("assertions removed at the sites named in #228", () => {
  it("config.ts no longer casts STELLAR_NETWORK", () => {
    expect(read("config.ts")).not.toMatch(/as\s+"testnet"\s*\|\s*"mainnet"/);
  });

  it("registry.ts no longer uses a non-null assertion on the simulation result", () => {
    const content = read("lib/registry.ts");
    expect(content).not.toMatch(/sim\.result!/);
    expect(content).not.toMatch(/\bas rpc\.Api\./);
    // Replaced by an explicit undefined check.
    expect(content).toMatch(/retval === undefined/);
  });

  it("admin.ts no longer casts the parsed project_ids array", () => {
    const content = read("routes/admin.ts");
    expect(content).not.toMatch(/raw as number\[\]/);
    expect(content).not.toMatch(/reason!/);
  });

  it("the three named files carry no non-null assertions at all", () => {
    for (const file of ["config.ts", "lib/registry.ts", "lib/stellar.ts", "routes/admin.ts"]) {
      expect(read(file)).not.toMatch(/\w!\./);
    }
  });
});
