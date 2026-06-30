import { logger } from "./logger";

export interface SatelliteReading {
  forest_density_pct: number;
  ndvi_score: number;
  timestamp: number;
  source: string;
}

export interface SatelliteDataSource {
  name: string;
  priority: number;
  enabled: boolean;
  fetch(projectId: number): Promise<SatelliteReading>;
}

export interface SourceHealth {
  name: string;
  healthy: boolean;
  lastChecked: number;
  failureCount: number;
  lastError?: string;
}

/** Conservative fallback when all sources fail and no cache entry exists. */
export const CONSERVATIVE_SATELLITE_DEFAULT: Omit<SatelliteReading, "timestamp"> = {
  forest_density_pct: 50,
  ndvi_score: 0.5,
  source: "conservative-fallback",
};

/**
 * How long (ms) a cached reading is considered fresh enough to serve.
 * Default: 2 hours. Overridable via SATELLITE_CACHE_TTL_MS env var.
 */
const CACHE_TTL_MS = parseInt(process.env.SATELLITE_CACHE_TTL_MS ?? "7200000", 10);

/**
 * How many consecutive total-outage events before an alert is emitted.
 * Default: 3 (≈ 3 cron cycles). Overridable via SATELLITE_ALERT_THRESHOLD.
 */
const ALERT_THRESHOLD = parseInt(process.env.SATELLITE_ALERT_THRESHOLD ?? "3", 10);

// ── In-memory cache ────────────────────────────────────────────────────────────
interface CacheEntry {
  reading: SatelliteReading;
  cachedAt: number;
}

const satelliteCache = new Map<number, CacheEntry>();

/** Write a fresh reading into the cache. */
function cacheSet(projectId: number, reading: SatelliteReading): void {
  satelliteCache.set(projectId, { reading, cachedAt: Date.now() });
}

/** Return a cached reading if it exists and hasn't expired, else null. */
function cacheGet(projectId: number): SatelliteReading | null {
  const entry = satelliteCache.get(projectId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    satelliteCache.delete(projectId);
    return null;
  }
  return { ...entry.reading };
}

/** Wipe a single cache entry (used in tests). */
export function cacheClear(projectId?: number): void {
  if (projectId === undefined) {
    satelliteCache.clear();
  } else {
    satelliteCache.delete(projectId);
  }
}

/** Expose cache stats for health endpoint. */
export function getCacheStats(): { entries: number; ttlMs: number } {
  return { entries: satelliteCache.size, ttlMs: CACHE_TTL_MS };
}

// ── Outage tracking ────────────────────────────────────────────────────────────
interface OutageState {
  consecutiveFailures: number;
  outageStartedAt: number | null;
  lastAlertAt: number | null;
}

const outageState: OutageState = {
  consecutiveFailures: 0,
  outageStartedAt: null,
  lastAlertAt: null,
};

function recordOutageFailure(): void {
  outageState.consecutiveFailures += 1;
  if (outageState.outageStartedAt === null) {
    outageState.outageStartedAt = Date.now();
  }

  if (outageState.consecutiveFailures >= ALERT_THRESHOLD) {
    const outageDurationMs = Date.now() - (outageState.outageStartedAt ?? Date.now());
    logger.error("[satellite] ALERT: extended satellite data outage", {
      consecutiveFailures: outageState.consecutiveFailures,
      outageDurationMs,
      outageDurationMinutes: Math.round(outageDurationMs / 60_000),
    });
    outageState.lastAlertAt = Date.now();
  }
}

function recordOutageRecovery(): void {
  if (outageState.outageStartedAt !== null) {
    const outageDurationMs = Date.now() - outageState.outageStartedAt;
    logger.info("[satellite] satellite data sources recovered", {
      outageDurationMs,
      consecutiveFailures: outageState.consecutiveFailures,
    });
  }
  outageState.consecutiveFailures = 0;
  outageState.outageStartedAt = null;
  outageState.lastAlertAt = null;
}

export function getOutageState(): Readonly<OutageState> {
  return { ...outageState };
}

// ── Per-source health ──────────────────────────────────────────────────────────
const healthMap = new Map<string, SourceHealth>();

/**
 * Generates a deterministic pseudo-random number in [0, 1) for a given seed.
 * Uses a MurmurHash3 finalizer to ensure avalanche: nearby seeds produce
 * vastly different outputs, preventing seed collision for adjacent project IDs.
 * The offset parameter shifts the hourSeed for secondary values (e.g., drift).
 */
function seededRandom(seed: number, offset = 0): number {
  const hourSeed = Math.floor(Date.now() / 3_600_000);
  let h = (seed * 2654435761) ^ ((hourSeed + offset) * 40503) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xffffffff;
}

function markHealthy(name: string): void {
  const existing = healthMap.get(name);
  healthMap.set(name, {
    name,
    healthy: true,
    lastChecked: Date.now(),
    failureCount: 0,
    lastError: undefined,
    ...(existing && { failureCount: 0 }),
  });
}

function markUnhealthy(name: string, error: string): void {
  const existing = healthMap.get(name);
  healthMap.set(name, {
    name,
    healthy: false,
    lastChecked: Date.now(),
    failureCount: (existing?.failureCount ?? 0) + 1,
    lastError: error,
  });
}

// Built-in source: primary (Sentinel-2 style)
const sentinel2Source: SatelliteDataSource = {
  name: "sentinel-2",
  priority: 1,
  enabled: true,
  async fetch(projectId: number): Promise<SatelliteReading> {
    const base = seededRandom(projectId * 3 + 5);
    const drift = seededRandom(projectId * 11 + 2);
    const forest_density_pct = Math.min(100, Math.max(0, 30 + base * 65 + drift * 5 - 2.5));
    return {
      forest_density_pct: Math.round(forest_density_pct * 100) / 100,
      ndvi_score: Math.round(Math.min(1, forest_density_pct / 100) * 1000) / 1000,
      timestamp: Date.now(),
      source: "sentinel-2",
    };
  },
};

// Built-in source: secondary fallback (Landsat style)
const landsatSource: SatelliteDataSource = {
  name: "landsat-8",
  priority: 2,
  enabled: true,
  async fetch(projectId: number): Promise<SatelliteReading> {
    const base = seededRandom(projectId * 5 + 3, 1);
    const drift = seededRandom(projectId * 13 + 7, 1);
    const forest_density_pct = Math.min(100, Math.max(0, 28 + base * 60 + drift * 4 - 2));
    return {
      forest_density_pct: Math.round(forest_density_pct * 100) / 100,
      ndvi_score: Math.round(Math.min(1, forest_density_pct / 100) * 1000) / 1000,
      timestamp: Date.now(),
      source: "landsat-8",
    };
  },
};

const sources: SatelliteDataSource[] = [sentinel2Source, landsatSource];

export function registerSource(source: SatelliteDataSource): void {
  const existing = sources.findIndex((s) => s.name === source.name);
  if (existing >= 0) {
    sources[existing] = source;
  } else {
    sources.push(source);
  }
  sources.sort((a, b) => a.priority - b.priority);
}

export function getSources(): SatelliteDataSource[] {
  return [...sources];
}

export function configureSource(
  name: string,
  updates: Partial<Pick<SatelliteDataSource, "enabled" | "priority">>,
): boolean {
  const source = sources.find((s) => s.name === name);
  if (!source) return false;
  if (updates.enabled !== undefined) source.enabled = updates.enabled;
  if (updates.priority !== undefined) {
    source.priority = updates.priority;
    sources.sort((a, b) => a.priority - b.priority);
  }
  return true;
}

/**
 * Fetch satellite data with graceful degradation:
 *
 * 1. Try each enabled source in priority order.
 * 2. On total failure, serve cached data if available (up to CACHE_TTL_MS old).
 * 3. If no cache, fall back to conservative estimates (forest_density_pct=50).
 * 4. Log all failures; emit an alert after ALERT_THRESHOLD consecutive outages.
 *
 * The `dataSource` field in the returned reading tells callers how it was obtained:
 * "live", "cache", or "conservative-fallback".
 */
export async function fetchSatelliteWithFallback(
  projectId: number,
): Promise<SatelliteReading & { dataSource: "live" | "cache" | "conservative-fallback" }> {
  const enabled = sources.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);

  // ── 1. Try live sources ──────────────────────────────────────────────────
  for (const source of enabled) {
    try {
      const data = await source.fetch(projectId);
      markHealthy(source.name);

      // Cache the successful reading and reset outage state
      cacheSet(projectId, data);
      recordOutageRecovery();

      return { ...data, dataSource: "live" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markUnhealthy(source.name, msg);
      logger.warn("[satellite] source fetch failed", {
        source: source.name,
        projectId,
        error: msg,
      });
    }
  }

  // All sources failed — record outage
  recordOutageFailure();
  logger.error("[satellite] all sources failed for project", {
    projectId,
    sources: enabled.map((s) => s.name),
    consecutiveFailures: outageState.consecutiveFailures,
  });

  // ── 2. Cache fallback ────────────────────────────────────────────────────
  const cached = cacheGet(projectId);
  if (cached) {
    const ageMs = Date.now() - cached.timestamp;
    logger.warn("[satellite] serving cached data due to source failure", {
      projectId,
      source: cached.source,
      ageMs,
      ageMinutes: Math.round(ageMs / 60_000),
    });
    return { ...cached, source: `${cached.source}(cached)`, dataSource: "cache" };
  }

  // ── 3. Conservative estimate ─────────────────────────────────────────────
  logger.warn("[satellite] no cache available, using conservative defaults", { projectId });
  return {
    ...CONSERVATIVE_SATELLITE_DEFAULT,
    timestamp: Date.now(),
    dataSource: "conservative-fallback",
  };
}

export function getSourceHealth(): SourceHealth[] {
  return sources.map((s) => {
    const h = healthMap.get(s.name);
    return h ?? { name: s.name, healthy: true, lastChecked: Date.now(), failureCount: 0 };
  });
}
