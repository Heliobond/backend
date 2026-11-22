import {
  parseContractError,
  lookupContractError,
  isContractError,
  isContractErrorRetryable,
  getContractErrorTable,
  loadContractErrorTable,
} from "../lib/contractErrors";

describe("contractErrors", () => {
  describe("loadContractErrorTable & getContractErrorTable", () => {
    it("loads and returns contract error table", () => {
      const table = loadContractErrorTable();
      expect(table).toBeDefined();
      expect(table.registry).toBeDefined();
      expect(table.vault).toBeDefined();
      expect(getContractErrorTable()).toBe(table);
    });
  });

  describe("lookupContractError", () => {
    it("returns mapped registry definition", () => {
      const err = lookupContractError("registry", 7);
      expect(err).toEqual({
        source: "registry",
        code: 7,
        name: "ProjectNotFound",
        retryable: false,
        action: "permanent",
        description: "Project ID was not found in the registry",
      });
    });

    it("returns fallback for unknown code", () => {
      const err = lookupContractError("registry", 999);
      expect(err).toEqual({
        source: "registry",
        code: 999,
        name: "Unknown",
        retryable: false,
        action: "permanent",
        description: "Unknown contract error code 999 for source registry",
      });
    });
  });

  describe("parseContractError - mapped registry codes", () => {
    it("decodes code 1: NotWhitelisted (permanent)", () => {
      const res = parseContractError("HostError: Error(Contract, #1)");
      expect(res).toEqual({
        source: "registry",
        code: 1,
        name: "NotWhitelisted",
        retryable: false,
        action: "permanent",
        description: expect.any(String),
      });
    });

    it("decodes code 2: UpdateTooFrequent (retryable / retry after interval)", () => {
      const res = parseContractError("HostError: Error(Contract, #2)");
      expect(res).toEqual({
        source: "registry",
        code: 2,
        name: "UpdateTooFrequent",
        retryable: true,
        action: "retry",
        description: expect.any(String),
      });
    });

    it("decodes code 3: ProjectArchived (permanent)", () => {
      const res = parseContractError("HostError: Error(Contract, #3)");
      expect(res).toEqual({
        source: "registry",
        code: 3,
        name: "ProjectArchived",
        retryable: false,
        action: "permanent",
        description: expect.any(String),
      });
    });

    it("decodes code 4: Paused (retryable / defer)", () => {
      const res = parseContractError("HostError: Error(Contract, #4)");
      expect(res).toEqual({
        source: "registry",
        code: 4,
        name: "Paused",
        retryable: true,
        action: "defer",
        description: expect.any(String),
      });
    });

    it("decodes code 7: ProjectNotFound (permanent)", () => {
      const res = parseContractError("HostError: Error(Contract, #7)");
      expect(res).toEqual({
        source: "registry",
        code: 7,
        name: "ProjectNotFound",
        retryable: false,
        action: "permanent",
        description: expect.any(String),
      });
    });

    it("decodes code 8: ScoresOutOfRange (permanent)", () => {
      const res = parseContractError("HostError: Error(Contract, #8)");
      expect(res).toEqual({
        source: "registry",
        code: 8,
        name: "ScoresOutOfRange",
        retryable: false,
        action: "permanent",
        description: expect.any(String),
      });
    });
  });

  describe("parseContractError - mapped vault codes", () => {
    it("decodes code 1 for vault: VaultPaused (retryable / defer)", () => {
      const res = parseContractError("vault error: Error(Contract, #1)", "vault");
      expect(res).toEqual({
        source: "vault",
        code: 1,
        name: "VaultPaused",
        retryable: true,
        action: "defer",
        description: expect.any(String),
      });
    });

    it("decodes code 2 for vault: Unauthorized (permanent)", () => {
      const res = parseContractError("vault error: Error(Contract, #2)", "vault");
      expect(res).toEqual({
        source: "vault",
        code: 2,
        name: "Unauthorized",
        retryable: false,
        action: "permanent",
        description: expect.any(String),
      });
    });

    it("decodes code 3 for vault: InsufficientBalance (permanent)", () => {
      const res = parseContractError("vault error: Error(Contract, #3)", "vault");
      expect(res).toEqual({
        source: "vault",
        code: 3,
        name: "InsufficientBalance",
        retryable: false,
        action: "permanent",
        description: expect.any(String),
      });
    });
  });

  describe("parseContractError - unknown code fallback", () => {
    it("falls back to Unknown for unmapped code 99 while preserving code", () => {
      const res = parseContractError("HostError: Error(Contract, #99)");
      expect(res).toEqual({
        source: "registry",
        code: 99,
        name: "Unknown",
        retryable: false,
        action: "permanent",
        description: "Unknown contract error code 99 for source registry",
      });
    });

    it("preserves source vault for unknown vault code", () => {
      const res = parseContractError("vault simulation failed: Error(Contract, #888)", "vault");
      expect(res).toEqual({
        source: "vault",
        code: 888,
        name: "Unknown",
        retryable: false,
        action: "permanent",
        description: "Unknown contract error code 888 for source vault",
      });
    });
  });

  describe("parseContractError - non-contract messages return null", () => {
    it("returns null for generic network timeout error", () => {
      expect(parseContractError("network timeout after 5000ms")).toBeNull();
    });

    it("returns null for standard Stellar tx error like tx_bad_auth", () => {
      expect(parseContractError("tx_bad_auth")).toBeNull();
    });

    it("returns null for numbers, empty strings, null, and undefined", () => {
      expect(parseContractError("")).toBeNull();
      expect(parseContractError(null)).toBeNull();
      expect(parseContractError(undefined)).toBeNull();
      expect(parseContractError(500)).toBeNull();
    });

    it("returns null for ledger error message without contract panic", () => {
      expect(parseContractError("transaction failed on ledger 45123")).toBeNull();
    });
  });

  describe("parseContractError - input variations", () => {
    it("parses Error instances", () => {
      const err = new Error("simulation error: HostError: Error(Contract, #7)");
      expect(parseContractError(err)).toMatchObject({
        code: 7,
        name: "ProjectNotFound",
      });
    });

    it("parses structured objects with error property", () => {
      const obj = { error: "HostError: Error(Contract, #8)" };
      expect(parseContractError(obj)).toMatchObject({
        code: 8,
        name: "ScoresOutOfRange",
      });
    });

    it("parses simulation result object with nested error", () => {
      const obj = {
        result: {
          error: "Error(Contract, #2)",
        },
      };
      expect(parseContractError(obj)).toMatchObject({
        code: 2,
        name: "UpdateTooFrequent",
      });
    });

    it("parses Error(Contract, N) without hash prefix", () => {
      expect(parseContractError("Error(Contract, 7)")).toMatchObject({
        code: 7,
        name: "ProjectNotFound",
      });
    });
  });

  describe("isContractError and isContractErrorRetryable", () => {
    it("isContractError returns true for contract errors", () => {
      expect(isContractError("Error(Contract, #1)")).toBe(true);
      expect(isContractError("timeout")).toBe(false);
    });

    it("isContractErrorRetryable returns true only for retryable codes", () => {
      // UpdateTooFrequent is retryable
      expect(isContractErrorRetryable("Error(Contract, #2)")).toBe(true);
      // Paused is retryable (defer)
      expect(isContractErrorRetryable("Error(Contract, #4)")).toBe(true);
      // NotWhitelisted is permanent
      expect(isContractErrorRetryable("Error(Contract, #1)")).toBe(false);
      // ScoresOutOfRange is permanent
      expect(isContractErrorRetryable("Error(Contract, #8)")).toBe(false);
      // Unknown is permanent
      expect(isContractErrorRetryable("Error(Contract, #99)")).toBe(false);
      // Non-contract is false
      expect(isContractErrorRetryable("timeout")).toBe(false);
    });
  });
});
