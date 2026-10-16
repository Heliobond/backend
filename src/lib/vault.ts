import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  BASE_FEE,
  scValToNative,
  rpc,
  Account,
  StrKey,
} from "@stellar/stellar-sdk";
import { withRpcConnection, networkPassphrase, withRpcRetry } from "./stellar";
import { config } from "../config";
import { stellarRpcDuration, stellarRpcTotal } from "./prometheus";

// Simple in-memory cache for portfolio results (~15 second TTL) with bounded LRU eviction
interface CachedPortfolio {
  data: PortfolioInfo;
  timestamp: number;
}

const portfolioCache = new Map<string, CachedPortfolio>();
export const CACHE_TTL_MS = 15_000; // 15 seconds
const DEFAULT_PORTFOLIO_CACHE_MAX_SIZE = 1000;

function getPortfolioCacheMaxSize(): number {
  const raw = process.env.PORTFOLIO_CACHE_MAX_SIZE;
  if (!raw) return DEFAULT_PORTFOLIO_CACHE_MAX_SIZE;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_PORTFOLIO_CACHE_MAX_SIZE;
  }
  return parsed;
}

/**
 * Evicts expired entries first, then evicts oldest entries LRU-style
 * until the cache fits within the max entry bound.
 */
export function evictPortfolioCacheTo(max: number): void {
  const now = Date.now();
  for (const [key, entry] of portfolioCache.entries()) {
    if (now - entry.timestamp >= CACHE_TTL_MS) {
      portfolioCache.delete(key);
    }
  }

  while (portfolioCache.size > max) {
    const oldestKey = portfolioCache.keys().next().value;
    if (oldestKey !== undefined) {
      portfolioCache.delete(oldestKey);
    } else {
      break;
    }
  }
}

/** Test helpers for cache introspection and deterministic cleanup */
export function _resetPortfolioCache(): void {
  portfolioCache.clear();
}

export function _getPortfolioCacheSize(): number {
  return portfolioCache.size;
}

/**
 * Portfolio information returned from the vault's get_portfolio function.
 * All monetary values are in USDC (i128 represented as string for precision).
 */
export interface PortfolioInfo {
  shares: string; // i128 as string
  usdc_value: string; // i128 as string
  claimable_yield: string; // i128 as string
  share_of_pool_bps: number; // basis points (0-10000)
  total_deposited: string; // i128 as string
}

/**
 * Validates that a string is a valid Stellar strkey (G... account or C... contract).
 * @throws Error if the address is invalid
 */
export function validateStellarAddress(address: string): void {
  if (!address || typeof address !== "string") {
    throw new Error("address must be a non-empty string");
  }

  const trimmed = address.trim();
  if (trimmed.length !== 56) {
    throw new Error("Stellar addresses must be 56 characters");
  }

  if (!trimmed.startsWith("G") && !trimmed.startsWith("C")) {
    throw new Error("address must start with G (account) or C (contract)");
  }

  try {
    if (trimmed.startsWith("G")) {
      StrKey.decodeEd25519PublicKey(trimmed);
    } else {
      StrKey.decodeContract(trimmed);
    }
  } catch (err) {
    throw new Error(
      `invalid Stellar address: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    );
  }
}

/**
 * Calls the vault's get_portfolio(account) function to retrieve the portfolio
 * information for a given address. This is a read-only simulation call that
 * does not submit a transaction.
 *
 * Results are cached for ~15 seconds to avoid excessive RPC calls.
 *
 * @param address - Stellar account (G...) or contract (C...) address
 * @returns Portfolio information including shares, value, yield, etc.
 * @throws Error if the vault contract ID is not configured or the simulation fails
 */
export async function getPortfolio(address: string): Promise<PortfolioInfo> {
  if (!config.INVESTMENT_VAULT_CONTRACT_ID) {
    throw new Error("INVESTMENT_VAULT_CONTRACT_ID env var is required to query portfolio");
  }

  if (!address || typeof address !== "string") {
    throw new Error("address must be a non-empty string");
  }

  const normalizedAddress = address.trim();
  validateStellarAddress(normalizedAddress);

  // Check cache and evict expired entry on read
  const cached = portfolioCache.get(normalizedAddress);
  const now = Date.now();
  if (cached) {
    if (now - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
    portfolioCache.delete(normalizedAddress);
  }

  const portfolio = await withRpcConnection(async (client) => {
    const contract = new Contract(config.INVESTMENT_VAULT_CONTRACT_ID!);
    const dummyAccount = new Account(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "0",
    );

    // Convert the address to a ScVal Address type
    const addressParam = nativeToScVal(normalizedAddress, { type: "address" });

    const tx = new TransactionBuilder(dummyAccount, { fee: BASE_FEE, networkPassphrase })
      .addOperation(contract.call("get_portfolio", addressParam))
      .setTimeout(config.TX_TIMEOUT_SECONDS)
      .build();

    const end = stellarRpcDuration.startTimer({ operation: "simulateTransaction" });

    let sim: rpc.Api.SimulateTransactionResponse;
    try {
      sim = await withRpcRetry(
        () => client.simulateTransaction(tx),
        "stellar:simulateTransaction:getPortfolio",
      );
    } catch (err) {
      end();
      stellarRpcTotal.inc({ operation: "simulateTransaction", result: "failure" });
      throw err;
    }

    if ("error" in sim) {
      end();
      stellarRpcTotal.inc({ operation: "simulateTransaction", result: "failure" });
      throw new Error(`get_portfolio simulation failed: ${sim.error}`);
    }

    const retval = sim.result?.retval;
    if (retval === undefined) {
      end();
      stellarRpcTotal.inc({ operation: "simulateTransaction", result: "failure" });
      throw new Error("get_portfolio simulation returned no result value");
    }

    end();
    stellarRpcTotal.inc({ operation: "simulateTransaction", result: "success" });

    // Decode the return value - expected to be a struct with fields:
    // { shares, usdc_value, claimable_yield, share_of_pool_bps, total_deposited }
    const portfolio = scValToNative(retval) as {
      shares: bigint;
      usdc_value: bigint;
      claimable_yield: bigint;
      share_of_pool_bps: number;
      total_deposited: bigint;
    };

    return {
      shares: portfolio.shares.toString(),
      usdc_value: portfolio.usdc_value.toString(),
      claimable_yield: portfolio.claimable_yield.toString(),
      share_of_pool_bps: portfolio.share_of_pool_bps,
      total_deposited: portfolio.total_deposited.toString(),
    };
  });

  // Cache the result with LRU bounding
  portfolioCache.set(normalizedAddress, { data: portfolio, timestamp: Date.now() });
  const max = getPortfolioCacheMaxSize();
  if (portfolioCache.size > max) {
    evictPortfolioCacheTo(max);
  }

  return portfolio;
}

/**
 * Converts an i128 string value to a human-readable decimal with 7 decimal places
 * (standard for USDC on Stellar which uses 7 decimal places, not 6 like Ethereum).
 * Safely handles positive, negative, and zero values with decimal clamping and input validation.
 */
export function i128ToDecimal(value: string | number | bigint, decimals: number = 7): string {
  if (value === null || value === undefined) {
    throw new Error("i128 value cannot be null or undefined");
  }

  const str = String(value).trim();
  if (!str || !/^-?\d+$/.test(str)) {
    throw new Error(`Invalid i128 numeric string: ${value}`);
  }

  if (decimals < 0) {
    throw new Error("decimals cannot be negative");
  }

  const bigIntValue = BigInt(str);
  if (bigIntValue === 0n) {
    return "0";
  }

  const isNegative = bigIntValue < 0n;
  const absValue = isNegative ? -bigIntValue : bigIntValue;
  const divisor = 10n ** BigInt(decimals);

  const integerPart = absValue / divisor;
  const fractionalPart = absValue % divisor;

  let result: string;
  if (fractionalPart === 0n) {
    result = integerPart.toString();
  } else {
    const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
    result = `${integerPart}.${fractionalStr}`.replace(/\.?0+$/, "");
  }

  return isNegative && result !== "0" ? `-${result}` : result;
}
