import { logger } from "./logger";

interface QueueEntry {
  promise: Promise<unknown>;
  timestamp: number;
}

const queues = new Map<number, QueueEntry>();

/** Max age of an in-flight entry before it is considered stuck and replaced */
const CACHE_TTL_MS = 30_000;

/**
 * Serialize concurrent requests for the same project.
 * The first request executes the handler; requests arriving while it is
 * in flight share its result. Nothing is cached once it settles.
 */
export async function withProjectLock<T>(projectId: number, handler: () => Promise<T>): Promise<T> {
  const existing = queues.get(projectId);

  if (existing) {
    const age = Date.now() - existing.timestamp;

    // Check if cached entry has expired
    if (age >= CACHE_TTL_MS) {
      logger.debug("In-flight entry expired, removing", { projectId, age });
      queues.delete(projectId);
    } else {
      logger.debug("Request queued, waiting for in-flight", { projectId });
      return existing.promise as Promise<T>;
    }
  }

  const entry: QueueEntry = {
    promise: handler(),
    timestamp: Date.now(),
  };
  queues.set(projectId, entry);

  try {
    return (await entry.promise) as T;
  } finally {
    if (queues.get(projectId) === entry) {
      queues.delete(projectId);
    }
  }
}
