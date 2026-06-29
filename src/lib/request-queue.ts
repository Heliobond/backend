import { logger } from "./logger";

interface QueueEntry {
  promise: Promise<unknown>;
}

const queues = new Map<number, QueueEntry>();

/**
 * Serialize concurrent requests for the same project.
 * The first request executes the handler; subsequent requests
 * wait for the same result without re-executing.
 */
export async function withProjectLock<T>(
  projectId: number,
  handler: () => Promise<T>,
): Promise<T> {
  const existing = queues.get(projectId);

  if (existing) {
    logger.debug("Request queued, waiting for in-flight", { projectId });
    return existing.promise as Promise<T>;
  }

  const entry: QueueEntry = { promise: handler() };
  queues.set(projectId, entry);

  try {
    const result = await entry.promise;
    return result as T;
  } finally {
    queues.delete(projectId);
  }
}
