import { RpcConnectionPool, PoolConfig } from "../lib/db-pool";

// rpc.Server is an HTTP client — no real network calls happen during construction
const baseConfig: PoolConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  allowHttp: false,
  minConnections: 2,
  maxConnections: 4,
  acquireTimeoutMs: 200,
  healthCheckIntervalMs: 60_000,
};

describe("RpcConnectionPool", () => {
  let pool: RpcConnectionPool;

  beforeEach(() => {
    pool = new RpcConnectionPool(baseConfig);
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  describe("configurable pool size", () => {
    it("pre-warms to minConnections on construction", () => {
      const m = pool.getMetrics();
      expect(m.total).toBe(2);
      expect(m.idle).toBe(2);
      expect(m.active).toBe(0);
    });

    it("grows up to maxConnections on demand", async () => {
      const c1 = await pool.acquire();
      const c2 = await pool.acquire();
      const c3 = await pool.acquire(); // beyond min — grows
      expect(pool.getMetrics().total).toBe(3);
      pool.release(c1);
      pool.release(c2);
      pool.release(c3);
    });

    it("respects maxConnections and queues waiters when at capacity", async () => {
      // Acquire all 4 slots
      const conns = await Promise.all([
        pool.acquire(),
        pool.acquire(),
        pool.acquire(),
        pool.acquire(),
      ]);
      expect(pool.getMetrics().active).toBe(4);
      expect(pool.getMetrics().pendingAcquires).toBe(0);

      // 5th acquire should queue
      let resolved = false;
      const pending = pool.acquire().then(c => { resolved = true; pool.release(c); });
      expect(pool.getMetrics().pendingAcquires).toBe(1);

      pool.release(conns[0]);
      await pending;
      expect(resolved).toBe(true);

      for (const c of conns.slice(1)) pool.release(c);
    });
  });

  describe("timeout handling", () => {
    it("rejects with timeout error when pool is exhausted and wait exceeds acquireTimeoutMs", async () => {
      const shortPool = new RpcConnectionPool({
        ...baseConfig,
        minConnections: 1,
        maxConnections: 1,
        acquireTimeoutMs: 50,
      });
      const conn = await shortPool.acquire();

      await expect(shortPool.acquire()).rejects.toThrow(/timed out/);
      shortPool.release(conn);
      await shortPool.shutdown();
    });
  });

  describe("pool metrics", () => {
    it("tracks totalAcquired and totalReleased", async () => {
      const c1 = await pool.acquire();
      const c2 = await pool.acquire();
      pool.release(c1);
      pool.release(c2);

      const m = pool.getMetrics();
      expect(m.totalAcquired).toBe(2);
      expect(m.totalReleased).toBe(2);
      expect(m.active).toBe(0);
      expect(m.idle).toBe(2);
    });

    it("returns accurate live counts", async () => {
      const c = await pool.acquire();
      expect(pool.getMetrics().active).toBe(1);
      expect(pool.getMetrics().idle).toBe(1);
      pool.release(c);
      expect(pool.getMetrics().active).toBe(0);
      expect(pool.getMetrics().idle).toBe(2);
    });
  });

  describe("withConnection helper", () => {
    it("acquires and releases automatically", async () => {
      await pool.withConnection(async () => {
        expect(pool.getMetrics().active).toBe(1);
      });
      expect(pool.getMetrics().active).toBe(0);
    });

    it("releases on error", async () => {
      await expect(
        pool.withConnection(async () => { throw new Error("boom"); })
      ).rejects.toThrow("boom");
      expect(pool.getMetrics().active).toBe(0);
    });
  });

  describe("graceful shutdown", () => {
    it("rejects new acquires after shutdown", async () => {
      await pool.shutdown();
      await expect(pool.acquire()).rejects.toThrow("shutting down");
    });

    it("rejects pending waiters immediately on shutdown", async () => {
      const maxPool = new RpcConnectionPool({ ...baseConfig, minConnections: 1, maxConnections: 1 });
      const conn = await maxPool.acquire();
      // This waiter is queued because the single slot is taken
      const pending = maxPool.acquire();
      // Attach rejection handler before shutdown fires to avoid unhandled rejection warning
      const assertion = expect(pending).rejects.toThrow(/shutting down/);
      // Release the held connection so shutdown can drain, then shut down
      const shutdownPromise = maxPool.shutdown();
      maxPool.release(conn);
      await Promise.all([shutdownPromise, assertion]);
    });
  });
});
