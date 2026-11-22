/**
 * Soroban contract error decoding and retry classification.
 *
 * Contract panics reach the backend in string form, for example `HostError: Error(Contract, #22)`.
 * This module parses the error code and decodes it against the registry and vault
 * error tables loaded from a shared JSON source of truth (`src/data/contractErrors.json`).
 */

import contractErrorsData from "../data/contractErrors.json";

export type ContractSource = "registry" | "vault";

export type RetryAction = "retry" | "defer" | "permanent";

export interface ContractErrorCodeDefinition {
  name: string;
  retryable: boolean;
  action: RetryAction;
  description: string;
}

export interface ContractErrorTable {
  registry: Record<string, ContractErrorCodeDefinition>;
  vault: Record<string, ContractErrorCodeDefinition>;
}

export interface DecodedContractError {
  source: ContractSource;
  code: number;
  name: string;
  retryable: boolean;
  action: RetryAction;
  description: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isContractErrorTable(value: unknown): value is ContractErrorTable {
  return isRecord(value) && isRecord(value.registry) && isRecord(value.vault);
}

/**
 * Typed loader for contract error codes table.
 * Validates the loaded JSON matches ContractErrorTable shape.
 */
export function loadContractErrorTable(): ContractErrorTable {
  const table: unknown = contractErrorsData;
  if (!isContractErrorTable(table)) {
    throw new Error("Invalid contract error table JSON structure");
  }
  return table;
}

const errorTable: ContractErrorTable = loadContractErrorTable();

/**
 * Access the loaded contract error definitions.
 */
export function getContractErrorTable(): ContractErrorTable {
  return errorTable;
}

/**
 * Looks up a contract error code in the table for a given source.
 * Falls back to name "Unknown" and retryable=false if not found.
 */
export function lookupContractError(source: ContractSource, code: number): DecodedContractError {
  const sourceTable = errorTable[source];
  const def = sourceTable ? sourceTable[String(code)] : undefined;

  if (def) {
    return {
      source,
      code,
      name: def.name,
      retryable: def.retryable,
      action: def.action,
      description: def.description,
    };
  }

  return {
    source,
    code,
    name: "Unknown",
    retryable: false,
    action: "permanent",
    description: `Unknown contract error code ${code} for source ${source}`,
  };
}

/**
 * Pattern matching Soroban contract panic formats:
 * - HostError: Error(Contract, #22)
 * - Error(Contract, #1)
 * - Error(Contract, 7)
 * - contract_error: #8
 */
const CONTRACT_ERROR_REGEX = /(?:Error\(Contract,\s*#?(\d+)\)|contract_error[^\d]*#?(\d+))/i;

/**
 * Extracts a searchable text string from an unknown error value or object.
 */
function extractErrorString(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (typeof err === "string") return err;

  if (err instanceof Error) {
    const parts = [err.message];
    const error: unknown = Reflect.get(err, "error");
    const errorResult: unknown = Reflect.get(err, "errorResult");
    if (typeof error === "string") parts.push(error);
    if (typeof errorResult === "string") parts.push(errorResult);
    if (isRecord(errorResult)) {
      try {
        parts.push(JSON.stringify(errorResult));
      } catch {
        // ignore circular
      }
    }
    return parts.join(" ");
  }

  if (isRecord(err)) {
    const e = err;
    const parts: string[] = [];
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.error === "string") parts.push(e.error);
    if (typeof e.errorResult === "string") parts.push(e.errorResult);
    if (typeof e.statusText === "string") parts.push(e.statusText);

    if (isRecord(e.result) && typeof e.result.error === "string") parts.push(e.result.error);

    try {
      parts.push(JSON.stringify(e));
    } catch {
      // ignore circular
    }

    return parts.join(" ");
  }

  return String(err);
}

/**
 * Detects whether the error context indicates a vault error vs registry error.
 */
function inferContractSource(
  rawText: string,
  code: number,
  defaultSource?: ContractSource,
): ContractSource {
  if (defaultSource) return defaultSource;

  const lower = rawText.toLowerCase();
  if (lower.includes("vault")) return "vault";
  if (lower.includes("registry")) return "registry";

  // Check if code exists uniquely in registry or vault
  const inRegistry = Boolean(errorTable.registry && errorTable.registry[String(code)]);
  const inVault = Boolean(errorTable.vault && errorTable.vault[String(code)]);

  if (inVault && !inRegistry) return "vault";
  return "registry";
}

/**
 * Parse `Error(Contract, #N)` from simulation or submission error messages/objects.
 *
 * Returns `{ source, code, name, retryable, action, description }`, where source is registry or vault.
 * Returns a safe fallback for unknown codes (`name: "Unknown"` with code preserved).
 * Returns `null` when the message is not a contract error.
 */
export function parseContractError(
  err: unknown,
  defaultSource?: ContractSource,
): DecodedContractError | null {
  const text = extractErrorString(err);
  if (!text) return null;

  const match = text.match(CONTRACT_ERROR_REGEX);
  if (!match) return null;

  const codeStr = match[1] || match[2];
  if (!codeStr) return null;

  const code = parseInt(codeStr, 10);
  if (Number.isNaN(code)) return null;

  const source = inferContractSource(text, code, defaultSource);
  return lookupContractError(source, code);
}

/**
 * Convenience check if an error is a contract panic.
 */
export function isContractError(err: unknown): boolean {
  return parseContractError(err) !== null;
}

/**
 * Check if a contract error is marked retryable.
 * Returns false if the error is not a contract error or not retryable.
 */
export function isContractErrorRetryable(err: unknown): boolean {
  const decoded = parseContractError(err);
  return decoded !== null && decoded.retryable;
}
