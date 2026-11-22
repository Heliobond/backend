import {
  withIotCache,
  clearIotCache,
  getIotCacheStats,
  getHourSeed,
  getSolarData,
  getSatelliteData,
} from "../lib/iot";

beforeEach(() => {
  clearIotCache();
  delete process.env.IOT_CACHE_DISABLED;
  delete process.env.IOT_CACHE_MAX_SIZE;
});

afterEach(() => {
  delete process.env.IOT_CACHE_DISABLED;
  delete process.env.IOT_CACHE_MAX_SIZE;
});

describe("withIotCache — cache miss", () => {
  it("calls the fetch function on first access", () => {
    const fn = jest.fn().mockReturnValue({ power_output_kw: 42 });
    withIotCache("solar:1:99999", fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns the value produced by the fetch function", () => {
    const result = withIotCache("solar:2:99999", () => ({ efficiency_pct: 75 }));
    expect(result).toEqual({ efficiency_pct: 75 });
  });
});

describe("withIotCache — cache hit", () => {
  it("does not call fetch again on the second access within TTL", () => {
    const fn = jest.fn().mockReturnValue({ power_output_kw: 42 });
    withIotCache("solar:3:99999", fn, 60_000);
    withIotCache("solar:3:99999", fn, 60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns the previously cached value on the second access", () => {
    const first = withIotCache("solar:4:99999", () => ({ val: "original" }), 60_000);
    const second = withIotCache("solar:4:99999", () => ({ val: "stale" }), 60_000);
    expect(first).toEqual({ val: "original" });
    expect(second).toEqual({ val: "original" });
  });

  it("isolates cache entries by key — different project IDs do not collide", () => {
    withIotCache("solar:10:99999", () => "projectA", 60_000);
    const b = withIotCache("solar:11:99999", () => "projectB", 60_000);
    expect(b).toBe("projectB");
  });
});

describe("withIotCache — TTL expiry", () => {
  it("fetches fresh data after the TTL has elapsed", () => {
    jest.useFakeTimers();

    const fn = jest.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");

    withIotCache("solar:5:99999", fn, 1_000); // prime cache
    jest.advanceTimersByTime(1_001); // expire TTL
    const result = withIotCache("solar:5:99999", fn, 1_000);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toBe("second");

    jest.useRealTimers();
  });

  it("does not refetch before the TTL elapses", () => {
    jest.useFakeTimers();

    const fn = jest.fn().mockReturnValue("data");
    withIotCache("solar:6:99999", fn, 5_000);
    jest.advanceTimersByTime(4_999);
    withIotCache("solar:6:99999", fn, 5_000);

    expect(fn).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});

describe("withIotCache — IOT_CACHE_DISABLED", () => {
  it("bypasses the cache entirely when IOT_CACHE_DISABLED=true", () => {
    process.env.IOT_CACHE_DISABLED = "true";

    const fn = jest.fn().mockReturnValue({ bypassed: true });
    withIotCache("solar:7:99999", fn, 60_000);
    withIotCache("solar:7:99999", fn, 60_000);
    withIotCache("solar:7:99999", fn, 60_000);

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("re-enables caching when IOT_CACHE_DISABLED is unset", () => {
    process.env.IOT_CACHE_DISABLED = "true";
    const fn = jest.fn().mockReturnValue(1);
    withIotCache("solar:8:99999", fn, 60_000);

    delete process.env.IOT_CACHE_DISABLED;
    withIotCache("solar:8:99999", fn, 60_000);
    withIotCache("solar:8:99999", fn, 60_000);

    // First call (disabled) + prime call + cached call = 2 total
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("withIotCache — IOT_CACHE_MAX_SIZE", () => {
  it("never grows past the configured cap", () => {
    process.env.IOT_CACHE_MAX_SIZE = "3";

    for (let i = 0; i < 10; i++) {
      withIotCache(`solar:${i}:99999`, () => i, 60_000);
    }

    expect(getIotCacheStats().entries).toBeLessThanOrEqual(3);
  });

  it("evicts the oldest entry first, keeping the newest", () => {
    process.env.IOT_CACHE_MAX_SIZE = "2";

    withIotCache("solar:100:99999", () => "oldest", 60_000);
    withIotCache("solar:101:99999", () => "middle", 60_000);
    withIotCache("solar:102:99999", () => "newest", 60_000);

    // The newest key survives and is served from cache...
    expect(withIotCache("solar:102:99999", () => "recomputed", 60_000)).toBe("newest");
    // ...while the oldest was evicted and has to be recomputed.
    expect(withIotCache("solar:100:99999", () => "recomputed", 60_000)).toBe("recomputed");
  });

  it("falls back to the default cap when the value is not a usable number", () => {
    process.env.IOT_CACHE_MAX_SIZE = "not-a-number";
    expect(getIotCacheStats().maxSize).toBe(1000);

    process.env.IOT_CACHE_MAX_SIZE = "0";
    expect(getIotCacheStats().maxSize).toBe(1000);
  });

  it("reports the configured cap through getIotCacheStats", () => {
    process.env.IOT_CACHE_MAX_SIZE = "42";
    expect(getIotCacheStats()).toMatchObject({ maxSize: 42, enabled: true });
  });
});

describe("getSolarData / getSatelliteData caching", () => {
  it("caches solar readings under solar:<projectId>:<hourSeed>", () => {
    getSolarData(7);
    expect(getIotCacheStats().entries).toBe(1);

    getSolarData(7);
    expect(getIotCacheStats().entries).toBe(1);
  });

  it("caches satellite readings under a separate key from solar", () => {
    getSolarData(7);
    getSatelliteData(7);
    expect(getIotCacheStats().entries).toBe(2);
  });

  it("keys cache entries per project id", () => {
    getSolarData(1);
    getSolarData(2);
    expect(getIotCacheStats().entries).toBe(2);
  });

  it("returns identical readings within the hour (deterministic as before)", () => {
    const first = getSolarData(9);
    const second = getSolarData(9);

    expect(second.power_output_kw).toBe(first.power_output_kw);
    expect(second.efficiency_pct).toBe(first.efficiency_pct);
    expect(second.max_power_kw).toBe(first.max_power_kw);
  });

  it("produces the same readings whether or not the cache is enabled", () => {
    const cached = getSolarData(11);

    process.env.IOT_CACHE_DISABLED = "true";
    const uncached = getSolarData(11);

    expect(uncached.efficiency_pct).toBe(cached.efficiency_pct);
    expect(uncached.power_output_kw).toBe(cached.power_output_kw);
  });

  it("does not cache anything when the cache is disabled", () => {
    process.env.IOT_CACHE_DISABLED = "true";
    getSolarData(12);
    getSatelliteData(12);
    expect(getIotCacheStats().entries).toBe(0);
  });

  it("stamps a fresh timestamp on a cache hit rather than replaying the cached one", () => {
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);
    const first = getSolarData(13);

    nowSpy.mockReturnValue(2_000);
    const second = getSolarData(13);

    expect(first.timestamp).toBe(1_000);
    expect(second.timestamp).toBe(2_000);
    nowSpy.mockRestore();
  });

  it("does not let a caller mutate the shared cache entry", () => {
    const first = getSolarData(14);
    first.efficiency_pct = -999;

    expect(getSolarData(14).efficiency_pct).not.toBe(-999);
  });

  it("exposes a numeric hour seed for cache keys", () => {
    expect(typeof getHourSeed()).toBe("number");
    expect(Number.isNaN(getHourSeed())).toBe(false);
  });
});
