export interface QueuedTransaction {
  projectId: number;
  creditQuality: number;
  greenImpact: number;
  queuedAt: number;
  retryCount: number;
  lastError?: string;
}

const queue: QueuedTransaction[] = [];

const MAX_RETRIES = 10;

export function enqueue(
  projectId: number,
  creditQuality: number,
  greenImpact: number,
  error?: string,
): void {
  const existing = queue.find((t) => t.projectId === projectId);
  if (existing) {
    existing.creditQuality = creditQuality;
    existing.greenImpact = greenImpact;
    existing.retryCount = 0;
    existing.lastError = error;
    return;
  }
  queue.push({
    projectId,
    creditQuality,
    greenImpact,
    queuedAt: Date.now(),
    retryCount: 0,
    lastError: error,
  });
}

export function dequeue(): QueuedTransaction | undefined {
  return queue.shift();
}

export function peek(): QueuedTransaction | undefined {
  return queue[0];
}

export function remove(projectId: number): void {
  const idx = queue.findIndex((t) => t.projectId === projectId);
  if (idx !== -1) queue.splice(idx, 1);
}

export function getQueueSize(): number {
  return queue.length;
}

export function getQueueContents(): QueuedTransaction[] {
  return [...queue];
}

export function incrementRetry(projectId: number, error?: string): void {
  const item = queue.find((t) => t.projectId === projectId);
  if (item) {
    item.retryCount++;
    item.lastError = error;
  }
}

export function hasExceededMaxRetries(projectId: number): boolean {
  const item = queue.find((t) => t.projectId === projectId);
  return item ? item.retryCount >= MAX_RETRIES : false;
}

export function getMaxRetries(): number {
  return MAX_RETRIES;
}

export function clearQueue(): void {
  queue.length = 0;
}
