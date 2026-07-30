import { logger } from "./logger";
import { config } from "../config";

const MAX_POWER_KW = config.MAX_POWER_KW;
const DEFAULT_EFFICIENCY_PCT = 60;
const DEFAULT_FOREST_DENSITY_PCT = 50;

// Configurable timezone for seeded-random hour boundaries.
// Defaults to UTC so results are identical across servers regardless of OS locale.
// Set CRON_TIMEZONE=America/New_York to align hourly boundaries with a local clock.
const CRON_TIMEZONE = process.env.CRON_TIMEZONE ?? "UTC";

/**
 * Returns a stable hour metric respecting CRON_TIMEZONE.
 * Defends aggressively against NaN parsing issues.
 *
 * Exported because it is also the cache-key component that gives IoT cache
 * entries their hourly expiry (see `withIotCache`).
 */
export function getHourSeed(): number {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      timeZone: CRON_TIMEZONE,
    });
    const parts = formatter.formatToParts(now);
    const get = (type: string): number => {
      const val = parts.find((p) => p.type === type)?.value;
      const parsed = parseInt(val ?? "0", 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    };

    const seed = (get("year") * 10000 + get("month") * 100 + get("day")) * 24 + get("hour");
    return Number.isNaN(seed) ? Math.floor(Date.now() / 3_600_000) : seed;
  } catch (error) {
    logger.error("Invalid CRON_TIMEZONE configuration, falling back to UTC epoch hours", {
      CRON_TIMEZONE,
      error,
    });
    return Math.floor(Date.now() / 3_600_000);
  }
}

/**
 * Generates a deterministic pseudo-random number in [0, 1) for a given seed.
 * Uses MurmurHash3 avalanche properties to avoid adjacent collision.
 */
export function seededRandom(seed: number): number {
  const hourSeed = getHourSeed();
  // Ensure the inputs aren't NaN before bitwise operations
  const safeSeed = Number.isNaN(seed) ? 0 : seed;

  let h = (safeSeed * 2654435761) ^ (hourSeed * 40503) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xffffffff;
}

// ── In-memory IoT data cache (#221) ──────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry<unknown>>();

/** Default cap on cached entries; overridable via IOT_CACHE_MAX_SIZE. */
const DEFAULT_CACHE_MAX_SIZE = 1000;

/**
 * The cache knobs are read on every call rather than captured at import time.
 * The cache is a pure performance layer over deterministic data, so operators
 * can flip `IOT_CACHE_DISABLED` or resize the cache without a restart, and
 * tests can exercise both paths without re-importing the module.
 */
function isCacheDisabled(): boolean {
  return process.env.IOT_CACHE_DISABLED === "true";
}

/**
 * Resolved entry cap. A missing, non-numeric or non-positive value falls back
 * to the default rather than throwing — a bad cache size must never be able to
 * take the IoT endpoints down.
 */
function cacheMaxSize(): number {
  const raw = process.env.IOT_CACHE_MAX_SIZE;
  if (!raw) return DEFAULT_CACHE_MAX_SIZE;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    logger.warn("Invalid IOT_CACHE_MAX_SIZE, falling back to default", {
      IOT_CACHE_MAX_SIZE: raw,
      default: DEFAULT_CACHE_MAX_SIZE,
    });
    return DEFAULT_CACHE_MAX_SIZE;
  }
  return parsed;
}

/** Returns milliseconds until the top of the next hour (minimum 1 ms). */
function msUntilNextHour(): number {
  const now = new Date();
  const ms = (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1_000 - now.getMilliseconds();
  return ms > 0 ? ms : 3_600_000;
}

/**
 * Drop expired entries, then evict oldest-first until the cache fits `max`.
 *
 * `Map` iterates in insertion order and `withIotCache` re-inserts on every
 * write, so the first keys returned are the least recently written — which for
 * hour-keyed entries is also the least recently used.
 */
function evictTo(max: number): void {
  const now = Date.now();
  for (const [key, entry] of _cache) {
    if (entry.expiresAt <= now) _cache.delete(key);
  }

  for (const key of _cache.keys()) {
    if (_cache.size <= max) break;
    _cache.delete(key);
  }
}

/**
 * Wraps a synchronous data-fetch function with an in-memory TTL cache.
 *
 * Cache key format: `solar:${projectId}:${hourSeed}` (or any caller-chosen key).
 * TTL defaults to the remainder of the current hour so cached values never
 * cross an hour boundary. Set `IOT_CACHE_DISABLED=true` to bypass entirely and
 * `IOT_CACHE_MAX_SIZE` to cap retained entries (default 1000).
 */
export function withIotCache<T>(key: string, fn: () => T, ttlMs?: number): T {
  if (isCacheDisabled()) {
    return fn();
  }

  const now = Date.now();
  const entry = _cache.get(key) as CacheEntry<T> | undefined;

  if (entry && entry.expiresAt > now) {
    return entry.value;
  }

  const value = fn();
  _cache.set(key, { value, expiresAt: now + (ttlMs ?? msUntilNextHour()) });

  const max = cacheMaxSize();
  if (_cache.size > max) evictTo(max);

  return value;
}

/** Clears all cached IoT entries. Intended for tests only. */
export function clearIotCache(): void {
  _cache.clear();
}

/** Cache introspection for tests and health/metrics surfaces. */
export function getIotCacheStats(): { entries: number; maxSize: number; enabled: boolean } {
  return { entries: _cache.size, maxSize: cacheMaxSize(), enabled: !isCacheDisabled() };
}

/** The deterministic part of a solar reading — everything except `timestamp`. */
function computeSolarReading(projectId: number) {
  const base = seededRandom(projectId);
  const drift = seededRandom(projectId * 7 + 1);

  if (Number.isNaN(base) || Number.isNaN(drift)) {
    logger.warn("getSolarData: seededRandom returned NaN, using fallback", {
      projectId,
      base,
      drift,
    });
  }

  const efficiency_pct = Math.min(98, Math.max(40, 40 + base * 58 + drift * 2 - 1));
  const power_output_kw = (efficiency_pct / 100) * MAX_POWER_KW;

  return {
    power_output_kw: Math.round(power_output_kw * 100) / 100,
    efficiency_pct: Math.round(efficiency_pct * 100) / 100,
    max_power_kw: MAX_POWER_KW,
  };
}

export function getSolarData(projectId: number) {
  if (projectId == null || Number.isNaN(projectId)) {
    logger.warn("getSolarData called with null/NaN projectId, using defaults", { projectId });
    return {
      power_output_kw: (DEFAULT_EFFICIENCY_PCT / 100) * MAX_POWER_KW,
      efficiency_pct: DEFAULT_EFFICIENCY_PCT,
      max_power_kw: MAX_POWER_KW,
      timestamp: Date.now(),
    };
  }

  // Only the deterministic fields are cached; `timestamp` stays the time of the
  // request so the response shape is indistinguishable from the uncached path,
  // and callers never receive a reference to the shared cache entry.
  const reading = withIotCache(`solar:${projectId}:${getHourSeed()}`, () =>
    computeSolarReading(projectId),
  );

  return { ...reading, timestamp: Date.now() };
}

/** The deterministic part of a satellite reading — everything except `timestamp`. */
function computeSatelliteReading(projectId: number) {
  const base = seededRandom(projectId * 3 + 5);
  const drift = seededRandom(projectId * 11 + 2);

  if (Number.isNaN(base) || Number.isNaN(drift)) {
    logger.warn("getSatelliteData: seededRandom returned NaN, using fallback", {
      projectId,
      base,
      drift,
    });
  }

  const forest_density_pct = Math.min(100, Math.max(0, 30 + base * 65 + drift * 5 - 2.5));
  return {
    forest_density_pct: Math.round(forest_density_pct * 100) / 100,
    ndvi_score: Math.round(Math.min(1, forest_density_pct / 100) * 1000) / 1000,
  };
}

export function getSatelliteData(projectId: number) {
  if (projectId == null || Number.isNaN(projectId)) {
    logger.warn("getSatelliteData called with null/NaN projectId, using defaults", { projectId });
    return {
      forest_density_pct: DEFAULT_FOREST_DENSITY_PCT,
      ndvi_score: Math.round(Math.min(1, DEFAULT_FOREST_DENSITY_PCT / 100) * 1000) / 1000,
      timestamp: Date.now(),
    };
  }

  // See getSolarData: deterministic fields cached, `timestamp` always fresh.
  const reading = withIotCache(`satellite:${projectId}:${getHourSeed()}`, () =>
    computeSatelliteReading(projectId),
  );

  return { ...reading, timestamp: Date.now() };
}
