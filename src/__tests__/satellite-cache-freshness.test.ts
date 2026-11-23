import type { SatelliteReading } from "../lib/satellite-sources";

const HOUR = 3_600_000;
const TTL = 2 * HOUR; // default SATELLITE_CACHE_TTL_MS
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const PROJECT = 4242;

type Mod = typeof import("../lib/satellite-sources");

/**
 * Loads a fresh copy of the module (module-level cache/source state) with the
 * built-in sources disabled and one controllable source registered.
 */
async function load(): Promise<{ mod: Mod; respond: (r: SatelliteReading | Error) => void }> {
  let next: SatelliteReading | Error = new Error("not configured");
  jest.resetModules();
  const mod: Mod = await import("../lib/satellite-sources");
  mod.configureSource("sentinel-2", { enabled: false });
  mod.configureSource("landsat-8", { enabled: false });
  mod.registerSource({
    name: "test-source",
    priority: 1,
    enabled: true,
    async fetch() {
      if (next instanceof Error) throw next;
      return { ...next };
    },
  });
  return { mod, respond: (r) => (next = r) };
}

function reading(observedAt: number): SatelliteReading {
  return { forest_density_pct: 77, ndvi_score: 0.77, timestamp: observedAt, source: "test-source" };
}

describe("satellite cache freshness uses observation age (#1083)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not cache an observation that is already stale when fetched", async () => {
    const { mod, respond } = await load();

    respond(reading(T0 - TTL - 1));
    const live = await mod.fetchSatelliteWithFallback(PROJECT);
    expect(live.dataSource).toBe("live");

    respond(new Error("down"));
    const fallback = await mod.fetchSatelliteWithFallback(PROJECT);
    expect(fallback.dataSource).toBe("conservative-fallback");
  });

  it("expires a cached reading by observation age, not by when it was cached", async () => {
    const { mod, respond } = await load();

    // Observed one hour before it was fetched: one hour of freshness left.
    respond(reading(T0 - HOUR));
    await mod.fetchSatelliteWithFallback(PROJECT);
    respond(new Error("down"));

    jest.setSystemTime(T0 + HOUR - 1);
    const stillFresh = await mod.fetchSatelliteWithFallback(PROJECT);
    expect(stillFresh.dataSource).toBe("cache");
    expect(stillFresh.timestamp).toBe(T0 - HOUR);
    expect(stillFresh.fetchedAt).toBe(T0);

    // Observation is now older than the TTL even though it was cached < TTL ago.
    jest.setSystemTime(T0 + HOUR + 1);
    const expired = await mod.fetchSatelliteWithFallback(PROJECT);
    expect(expired.dataSource).toBe("conservative-fallback");
  });

  it("keeps a fresh observation available for the full documented TTL", async () => {
    const { mod, respond } = await load();

    respond(reading(T0));
    await mod.fetchSatelliteWithFallback(PROJECT);
    respond(new Error("down"));

    jest.setSystemTime(T0 + TTL);
    expect((await mod.fetchSatelliteWithFallback(PROJECT)).dataSource).toBe("cache");

    jest.setSystemTime(T0 + TTL + 1);
    expect((await mod.fetchSatelliteWithFallback(PROJECT)).dataSource).toBe("conservative-fallback");
  });

  it("re-fetching an older observation does not replace or refresh a newer cached one", async () => {
    const { mod, respond } = await load();

    respond(reading(T0));
    await mod.fetchSatelliteWithFallback(PROJECT);

    jest.setSystemTime(T0 + HOUR);
    respond(reading(T0 - 30 * 60_000)); // older observation, still within TTL
    await mod.fetchSatelliteWithFallback(PROJECT);

    respond(new Error("down"));
    const fallback = await mod.fetchSatelliteWithFallback(PROJECT);
    expect(fallback.dataSource).toBe("cache");
    expect(fallback.timestamp).toBe(T0);
  });

  it("ages a future-timestamped observation from its fetch time", async () => {
    const { mod, respond } = await load();

    respond(reading(T0 + 10 * HOUR));
    await mod.fetchSatelliteWithFallback(PROJECT);
    respond(new Error("down"));

    jest.setSystemTime(T0 + TTL + 1);
    expect((await mod.fetchSatelliteWithFallback(PROJECT)).dataSource).toBe("conservative-fallback");
  });
});
