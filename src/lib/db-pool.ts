import { rpc } from "@stellar/stellar-sdk";
import crypto from "crypto";

export interface PoolConfig {
  rpcUrl: string;
  allowHttp: boolean;
  minConnections: number;
  maxConnections: number;
  acquireTimeoutMs: number;
  healthCheckIntervalMs: number;
}

export interface PoolMetrics {
  total: number;
  idle: number;
  active: number;
  pendingAcquires: number;
  healthCheckErrors: number;
  totalAcquired: number;
  totalReleased: number;
  totalCreated: number;
}

interface PooledConnection {
  id: string;
  client: rpc.Server;
  createdAt: number;
  lastUsedAt: number;
  inUse: boolean;
  healthy: boolean;
}

type WaitEntry = {
  resolve: (conn: PooledConnection) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RpcConnectionPool {
  private connections: PooledConnection[] = [];
  private waitQueue: WaitEntry[] = [];
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private metrics: PoolMetrics = {
    total: 0,
    idle: 0,
    active: 0,
    pendingAcquires: 0,
    healthCheckErrors: 0,
    totalAcquired: 0,
    totalReleased: 0,
    totalCreated: 0,
  };

  constructor(readonly config: PoolConfig) {
    for (let i = 0; i < config.minConnections; i++) {
      this.add();
    }
    this.scheduleHealthChecks();
  }

  private add(): PooledConnection {
    const conn: PooledConnection = {
      id: crypto.randomUUID(),
      client: new rpc.Server(this.config.rpcUrl, { allowHttp: this.config.allowHttp }),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      inUse: false,
      healthy: true,
    };
    this.connections.push(conn);
    this.metrics.total++;
    this.metrics.idle++;
    this.metrics.totalCreated++;
    return conn;
  }

  acquire(): Promise<PooledConnection> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("Pool is shutting down"));
    }

    const idle = this.connections.find(c => !c.inUse && c.healthy);
    if (idle) {
      return Promise.resolve(this.checkout(idle));
    }

    if (this.connections.length < this.config.maxConnections) {
      return Promise.resolve(this.checkout(this.add()));
    }

    return new Promise<PooledConnection>((resolve, reject) => {
      this.metrics.pendingAcquires++;
      const timer = setTimeout(() => {
        const idx = this.waitQueue.findIndex(e => e.timer === timer);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        this.metrics.pendingAcquires--;
        reject(new Error(`Pool acquire timed out after ${this.config.acquireTimeoutMs}ms`));
      }, this.config.acquireTimeoutMs);
      this.waitQueue.push({ resolve, reject, timer });
    });
  }

  private checkout(conn: PooledConnection): PooledConnection {
    conn.inUse = true;
    conn.lastUsedAt = Date.now();
    this.metrics.active++;
    this.metrics.idle--;
    this.metrics.totalAcquired++;
    return conn;
  }

  release(conn: PooledConnection): void {
    conn.inUse = false;
    conn.lastUsedAt = Date.now();
    this.metrics.active--;
    this.metrics.totalReleased++;

    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      clearTimeout(waiter.timer);
      this.metrics.pendingAcquires--;
      waiter.resolve(this.checkout(conn));
    } else {
      this.metrics.idle++;
    }
  }

  async withConnection<T>(fn: (client: rpc.Server) => Promise<T>): Promise<T> {
    const conn = await this.acquire();
    try {
      return await fn(conn.client);
    } finally {
      this.release(conn);
    }
  }

  getMetrics(): PoolMetrics {
    return {
      ...this.metrics,
      total: this.connections.length,
      active: this.connections.filter(c => c.inUse).length,
      idle: this.connections.filter(c => !c.inUse && c.healthy).length,
    };
  }

  private scheduleHealthChecks(): void {
    this.healthTimer = setInterval(async () => {
      const idle = this.connections.filter(c => !c.inUse);
      await Promise.allSettled(
        idle.map(async conn => {
          try {
            await conn.client.getLatestLedger();
            conn.healthy = true;
          } catch {
            conn.healthy = false;
            this.metrics.healthCheckErrors++;
          }
        })
      );
    }, this.config.healthCheckIntervalMs);
    // Don't keep the process alive just for health checks
    this.healthTimer.unref();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Pool is shutting down"));
    }
    this.waitQueue.length = 0;
    this.metrics.pendingAcquires = 0;

    // Drain active connections (max 10 s)
    const deadline = Date.now() + 10_000;
    while (this.connections.some(c => c.inUse) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }

    this.connections.length = 0;
    this.metrics.total = 0;
    this.metrics.active = 0;
    this.metrics.idle = 0;
  }
}
