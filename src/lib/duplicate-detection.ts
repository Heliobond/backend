export type UpdateStatus = 'in_flight' | 'completed' | 'failed';

export interface UpdateState {
  key: string;
  status: UpdateStatus;
  startedAt: number;
}

export interface TryBeginResult {
  allowed: boolean;
  key?: string;
  status?: UpdateStatus;
  reason?: string;
}

const store = new Map<number, UpdateState>();

const CLEANUP_INTERVAL_MS = 60_000;
const MAX_ENTRIES = 10_000;
let lastCleanup = Date.now();

function cleanup(maxAgeMs: number = 3_600_000): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  if (store.size > MAX_ENTRIES) {
    const sorted = [...store.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
    const toRemove = sorted.slice(0, sorted.length - MAX_ENTRIES);
    for (const [projectId] of toRemove) {
      store.delete(projectId);
    }
  }

  for (const [projectId, state] of store) {
    if (now - state.startedAt > maxAgeMs) {
      store.delete(projectId);
    }
  }
}

export function tryBeginUpdate(
  projectId: number,
  dedupWindowMs: number = 3_600_000,
  staleThresholdMs: number = 300_000,
): TryBeginResult {
  cleanup();

  const existing = store.get(projectId);

  if (existing) {
    if (existing.status === 'in_flight') {
      const age = Date.now() - existing.startedAt;
      if (age < staleThresholdMs) {
        return {
          allowed: false,
          key: existing.key,
          status: existing.status,
          reason: `Update already ${existing.status} for project ${projectId}`,
        };
      }
    } else if (existing.status === 'completed' || existing.status === 'failed') {
      const age = Date.now() - existing.startedAt;
      if (age < dedupWindowMs) {
        return {
          allowed: false,
          key: existing.key,
          status: existing.status,
          reason: `Duplicate update for project ${projectId} (last ${existing.status} ${age}ms ago)`,
        };
      }
    }
  }

  const key = `update_${projectId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  store.set(projectId, { key, status: 'in_flight', startedAt: Date.now() });

  return { allowed: true, key, status: 'in_flight' };
}

export function markCompleted(projectId: number): void {
  const state = store.get(projectId);
  if (state) {
    state.status = 'completed';
  }
}

export function markFailed(projectId: number): void {
  const state = store.get(projectId);
  if (state) {
    state.status = 'failed';
  }
}

export function getStatus(projectId: number): UpdateState | undefined {
  return store.get(projectId);
}

export function clearState(): void {
  store.clear();
}
