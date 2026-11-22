import crypto from "crypto";
import { logger } from "./logger";

// ── Types ───────────────────────────────────────────────────────────────────

export type FlagValue = boolean | string | number;

export interface FlagDefinition {
  /** Whether the flag is enabled. */
  enabled: boolean;
  /** Percentage of users who see this flag (0–100). */
  rollout_percentage: number;
  /** Env-specific overrides: if set, overrides enabled/rollout for that env. */
  env_overrides?: Record<string, Partial<Pick<FlagDefinition, "enabled" | "rollout_percentage">>>;
  /** User-specific overrides: wallet address → enabled state. */
  user_overrides?: Record<string, boolean>;
  /** Flags that must be enabled for this flag to evaluate (dependency chain). */
  depends_on?: string[];
  /** Metadata attached to evaluations for analytics. */
  metadata?: Record<string, unknown>;
  /** Fixed value overrides per user (bypasses boolean logic). */
  variants?: Record<string, FlagValue>;
}

export interface FlagSet {
  [flagName: string]: FlagDefinition;
}

export interface EvaluationContext {
  /** Wallet address or user identifier. */
  user_id?: string;
  /** Current NODE_ENV. */
  environment: string;
  /** Additional attributes for percentage hashing. */
  attributes?: Record<string, string>;
}

export interface EvaluationResult {
  flag: string;
  value: boolean;
  reason:
    | "flag_not_found"
    | "disabled"
    | "enabled"
    | "rollout_included"
    | "rollout_excluded"
    | "env_override_disabled"
    | "env_override_enabled"
    | "user_override_enabled"
    | "user_override_disabled"
    | "dependency_not_met"
    | "dependency_cycle"
    | "variant_resolved";
  variant?: FlagValue;
  metadata?: Record<string, unknown>;
}

// ── Analytics ───────────────────────────────────────────────────────────────

export interface FlagEvaluation {
  flag: string;
  value: boolean;
  variant?: FlagValue;
  reason: string;
  user_id?: string;
  environment: string;
  timestamp: number;
}

const evaluationLog: FlagEvaluation[] = [];
const MAX_EVAL_LOG = 5000;

function recordEvaluation(result: EvaluationResult, ctx: EvaluationContext): void {
  const entry: FlagEvaluation = {
    flag: result.flag,
    value: result.value,
    variant: result.variant,
    reason: result.reason,
    user_id: ctx.user_id,
    environment: ctx.environment,
    timestamp: Date.now(),
  };
  evaluationLog.push(entry);
  if (evaluationLog.length > MAX_EVAL_LOG) {
    evaluationLog.shift();
  }
}

export function getEvaluations(filter?: {
  flag?: string;
  user_id?: string;
  since?: number;
}): FlagEvaluation[] {
  let results = evaluationLog;
  if (filter?.flag) results = results.filter((e) => e.flag === filter.flag);
  if (filter?.user_id) results = results.filter((e) => e.user_id === filter.user_id);
  if (filter?.since) results = results.filter((e) => e.timestamp >= filter.since!);
  return results;
}

export interface FlagAnalyticsSummary {
  total_evaluations: number;
  unique_flags: number;
  unique_users: number;
  by_flag: Record<string, { enabled: number; disabled: number; avg_rate: number }>;
  by_reason: Record<string, number>;
}

export function getFlagAnalytics(): FlagAnalyticsSummary {
  const byFlag: Record<string, { enabled: number; disabled: number }> = {};
  const byReason: Record<string, number> = {};

  for (const e of evaluationLog) {
    if (!byFlag[e.flag]) byFlag[e.flag] = { enabled: 0, disabled: 0 };
    if (e.value) byFlag[e.flag].enabled++;
    else byFlag[e.flag].disabled++;

    byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  }

  const byFlagFormatted: Record<string, { enabled: number; disabled: number; avg_rate: number }> =
    {};
  for (const [flag, counts] of Object.entries(byFlag)) {
    const total = counts.enabled + counts.disabled;
    byFlagFormatted[flag] = {
      enabled: counts.enabled,
      disabled: counts.disabled,
      avg_rate: total > 0 ? counts.enabled / total : 0,
    };
  }

  return {
    total_evaluations: evaluationLog.length,
    unique_flags: new Set(evaluationLog.map((e) => e.flag)).size,
    unique_users: new Set(evaluationLog.filter((e) => e.user_id).map((e) => e.user_id)).size,
    by_flag: byFlagFormatted,
    by_reason: byReason,
  };
}

// ── Feature Flag Engine ─────────────────────────────────────────────────────

let flags: FlagSet = {};
const dependencyCache: Map<string, boolean> = new Map();

/**
 * Generate a cache key for dependency evaluation.
 * Includes flag name and context properties that affect evaluation.
 */
function getDependencyCacheKey(flagName: string, ctx: EvaluationContext): string {
  // Include all context properties that could affect flag evaluation
  const contextKey = JSON.stringify({
    user_id: ctx.user_id,
    environment: ctx.environment,
    attributes: ctx.attributes || {}
  });
  return `${flagName}:${contextKey}`;
}

/**
 * Load or replace the entire flag set (e.g. from a JSON config file or remote source).
 */
export function loadFlags(flagSet: FlagSet): void {
  flags = { ...flagSet };
  dependencyCache.clear();
  logger.info("[feature-flags] loaded", { count: Object.keys(flags).length });
}

/**
 * Merge additional flags into the current set (useful for remote config updates).
 */
export function mergeFlags(partial: FlagSet): void {
  Object.assign(flags, partial);
  dependencyCache.clear();
  logger.info("[feature-flags] merged", { count: Object.keys(partial).length });
}

/**
 * Get the raw definition of a flag.
 */
export function getFlag(name: string): FlagDefinition | undefined {
  return flags[name];
}

/**
 * List all known flags.
 */
export function listFlags(): FlagSet {
  return { ...flags };
}

/**
 * Evaluate a single flag for a given context.
 */
export function evaluateFlag(flagName: string, ctx: EvaluationContext): EvaluationResult {
  return evaluateFlagInternal(flagName, ctx, new Set());
}

/**
 * Internal recursive evaluator. Tracks the chain of flags currently being
 * resolved (via `visiting`) so a circular depends_on graph is reported as a
 * dependency_cycle instead of recursing until the call stack overflows.
 */
function evaluateFlagInternal(
  flagName: string,
  ctx: EvaluationContext,
  visiting: Set<string>,
): EvaluationResult {
  const flag = flags[flagName];

  if (!flag) {
    const result: EvaluationResult = {
      flag: flagName,
      value: false,
      reason: "flag_not_found",
    };
    recordEvaluation(result, ctx);
    return result;
  }

  // 1. Check env overrides
  const envOverride = flag.env_overrides?.[ctx.environment];
  if (envOverride) {
    if (envOverride.enabled === false) {
      const result: EvaluationResult = {
        flag: flagName,
        value: false,
        reason: "env_override_disabled",
        metadata: flag.metadata,
      };
      recordEvaluation(result, ctx);
      return result;
    }
    if (envOverride.enabled === true) {
      const result: EvaluationResult = {
        flag: flagName,
        value: true,
        reason: "env_override_enabled",
        metadata: flag.metadata,
      };
      recordEvaluation(result, ctx);
      return result;
    }
    // env override may only specify rollout_percentage, continue to rollout logic
    if (envOverride.rollout_percentage !== undefined) {
      const pct = envOverride.rollout_percentage;
      const included = isUserInRollout(flagName, ctx, pct);
      const result: EvaluationResult = {
        flag: flagName,
        value: included,
        reason: included ? "rollout_included" : "rollout_excluded",
        metadata: flag.metadata,
      };
      recordEvaluation(result, ctx);
      return result;
    }
  }

  // 2. Check if flag is globally disabled
  if (!flag.enabled) {
    const result: EvaluationResult = {
      flag: flagName,
      value: false,
      reason: "disabled",
      metadata: flag.metadata,
    };
    recordEvaluation(result, ctx);
    return result;
  }

  // 3. Check dependencies
  // Check cache first - even for flags without dependencies (cache as true)
  const cacheKey = getDependencyCacheKey(flagName, ctx);
  const cachedResult = dependencyCache.get(cacheKey);
  
  if (cachedResult !== undefined) {
    // If cached result is false, dependencies are not satisfied
    if (!cachedResult) {
      const result: EvaluationResult = {
        flag: flagName,
        value: false,
        reason: "dependency_not_met",
        metadata: flag.metadata,
      };
      recordEvaluation(result, ctx);
      return result;
    }
    // If cached result is true, dependencies are satisfied, continue to next checks
  } else if (visiting.has(flagName)) {
    // This flag is already being resolved further up the call chain —
    // depends_on forms a cycle. Fail closed instead of recursing forever.
    const result: EvaluationResult = {
      flag: flagName,
      value: false,
      reason: "dependency_cycle",
      metadata: flag.metadata,
    };
    recordEvaluation(result, ctx);
    return result;
  } else {
    // Not in cache, evaluate dependencies if any exist
    let allDependenciesMet = true;
    if (flag.depends_on && flag.depends_on.length > 0) {
      visiting.add(flagName);
      for (const dep of flag.depends_on) {
        if (!evaluateFlagInternal(dep, ctx, visiting).value) {
          allDependenciesMet = false;
          break;
        }
      }
      visiting.delete(flagName);
    }

    // Cache the result (true for no dependencies or all satisfied, false otherwise)
    dependencyCache.set(cacheKey, allDependenciesMet);

    if (!allDependenciesMet) {
      const result: EvaluationResult = {
        flag: flagName,
        value: false,
        reason: "dependency_not_met",
        metadata: flag.metadata,
      };
      recordEvaluation(result, ctx);
      return result;
    }
  }

  // 4. Check user-specific override
  if (ctx.user_id && flag.user_overrides) {
    const userOverride = flag.user_overrides[ctx.user_id];
    if (userOverride !== undefined) {
      const result: EvaluationResult = {
        flag: flagName,
        value: userOverride,
        reason: userOverride ? "user_override_enabled" : "user_override_disabled",
        metadata: flag.metadata,
      };
      recordEvaluation(result, ctx);
      return result;
    }
  }

  // 5. Percentage rollout
  if (flag.rollout_percentage < 100) {
    const included = isUserInRollout(flagName, ctx, flag.rollout_percentage);
    const result: EvaluationResult = {
      flag: flagName,
      value: included,
      reason: included ? "rollout_included" : "rollout_excluded",
      metadata: flag.metadata,
    };
    recordEvaluation(result, ctx);
    return result;
  }

  // 6. Fully enabled
  const result: EvaluationResult = {
    flag: flagName,
    value: true,
    reason: "enabled",
    metadata: flag.metadata,
  };
  recordEvaluation(result, ctx);
  return result;
}

/**
 * Evaluate a flag and return a typed variant value (for A/B tests or multi-variant flags).
 */
export function evaluateVariant(
  flagName: string,
  ctx: EvaluationContext,
): { enabled: boolean; variant?: FlagValue } {
  const result = evaluateFlag(flagName, ctx);
  const flag = flags[flagName];

  if (result.value && flag?.variants) {
    // Deterministically pick a variant based on user_id
    const seed = ctx.user_id ?? ctx.environment;
    const hash = crypto.createHash("md5").update(`${flagName}:${seed}`).digest("hex");
    const keys = Object.keys(flag.variants);
    const idx = parseInt(hash.slice(0, 8), 16) % keys.length;
    return { enabled: true, variant: flag.variants[keys[idx]] };
  }

  return { enabled: result.value };
}

/**
 * Batch-evaluate multiple flags for a context.
 */
export function evaluateFlags(
  flagNames: string[],
  ctx: EvaluationContext,
): Record<string, EvaluationResult> {
  const results: Record<string, EvaluationResult> = {};
  for (const name of flagNames) {
    results[name] = evaluateFlag(name, ctx);
  }
  return results;
}

// ── Percentage rollout hashing ──────────────────────────────────────────────

/**
 * Deterministically decide if a user falls within a percentage rollout.
 * Uses MD5 of "flagName:user_id" for consistent assignment — the same user
 * always gets the same result for a given flag and percentage.
 */
function isUserInRollout(flagName: string, ctx: EvaluationContext, percentage: number): boolean {
  if (percentage <= 0) return false;
  if (percentage >= 100) return true;

  // Use user_id if available, otherwise fall back to environment
  const seed = ctx.user_id ?? `${ctx.environment}:anonymous`;
  const hash = crypto.createHash("md5").update(`${flagName}:${seed}`).digest("hex");
  const bucket = parseInt(hash.slice(0, 8), 16) / 0xffffffff; // 0–1

  return bucket * 100 < percentage;
}

// ── File-based config loader ────────────────────────────────────────────────

/**
 * Load flags from a JSON file. The file should export a FlagSet object.
 * Returns the loaded flags or throws on parse error.
 */
export async function loadFlagsFromFile(filePath: string): Promise<FlagSet> {
  const fs = await import("fs/promises");
  const content = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(content) as FlagSet;
  loadFlags(parsed);
  return parsed;
}

/**
 * Load flags from a JSON string.
 */
export function loadFlagsFromString(json: string): FlagSet {
  const parsed = JSON.parse(json) as FlagSet;
  loadFlags(parsed);
  return parsed;
}
