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

const healthMap = new Map<string, SourceHealth>();

function seededRandom(seed: number, offset = 0): number {
  const hourSeed = Math.floor(Date.now() / 3_600_000);
  const x = Math.sin(seed * 9301 + (hourSeed + offset) * 49297 + 233) * 10000;
  return x - Math.floor(x);
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

export function configureSource(name: string, updates: Partial<Pick<SatelliteDataSource, "enabled" | "priority">>): boolean {
  const source = sources.find((s) => s.name === name);
  if (!source) return false;
  if (updates.enabled !== undefined) source.enabled = updates.enabled;
  if (updates.priority !== undefined) {
    source.priority = updates.priority;
    sources.sort((a, b) => a.priority - b.priority);
  }
  return true;
}

export async function fetchSatelliteWithFallback(projectId: number): Promise<SatelliteReading> {
  const enabled = sources.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);

  for (const source of enabled) {
    try {
      const data = await source.fetch(projectId);
      markHealthy(source.name);
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markUnhealthy(source.name, msg);
    }
  }

  throw new Error("All satellite data sources failed");
}

export function getSourceHealth(): SourceHealth[] {
  return sources.map((s) => {
    const h = healthMap.get(s.name);
    return h ?? { name: s.name, healthy: true, lastChecked: Date.now(), failureCount: 0 };
  });
}
