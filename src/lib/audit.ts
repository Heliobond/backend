export interface AuditEntry {
  id: number;
  project_id: number;
  credit_quality: number;
  green_impact: number;
  tx_hash: string;
  triggered_by: string;
  timestamp: number;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const DEFAULT_MAX_AUDIT_LOG_ENTRIES = 1000;
export const MAX_AUDIT_LOG_ENTRIES = envInt("MAX_AUDIT_LOG_ENTRIES", DEFAULT_MAX_AUDIT_LOG_ENTRIES);

let maxEntriesOverride: number | null = null;
let seq = 0;
const store: AuditEntry[] = [];

export function setMaxAuditLogEntries(max: number | null): void {
  maxEntriesOverride = max !== null && max > 0 ? max : null;
  enforceRetentionCap();
}

export function getMaxAuditLogEntries(): number {
  return maxEntriesOverride ?? MAX_AUDIT_LOG_ENTRIES;
}

export function getAuditStoreSize(): number {
  return store.length;
}

function enforceRetentionCap(): void {
  const cap = getMaxAuditLogEntries();
  if (cap > 0 && store.length > cap) {
    store.splice(0, store.length - cap);
  }
}

export function recordAudit(
  entry: Omit<AuditEntry, "id" | "timestamp"> & { timestamp?: number },
): AuditEntry {
  const record: AuditEntry = {
    id: ++seq,
    timestamp: entry.timestamp ?? Date.now(),
    project_id: entry.project_id,
    credit_quality: entry.credit_quality,
    green_impact: entry.green_impact,
    tx_hash: entry.tx_hash,
    triggered_by: entry.triggered_by,
  };
  store.push(record);
  enforceRetentionCap();
  return record;
}

export interface AuditLogOptions {
  project_id?: number;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export function getAuditLog(opts: AuditLogOptions = {}): AuditEntry[] {
  const filtered = store.filter((e) => {
    if (opts.project_id !== undefined && e.project_id !== opts.project_id) return false;
    if (opts.from !== undefined && e.timestamp < opts.from) return false;
    if (opts.to !== undefined && e.timestamp > opts.to) return false;
    return true;
  });

  if (opts.offset !== undefined || opts.limit !== undefined) {
    const start = Math.max(0, opts.offset ?? 0);
    const end = opts.limit !== undefined ? start + Math.max(0, opts.limit) : undefined;
    return filtered.slice(start, end);
  }

  return filtered;
}

export function auditToCsv(entries: AuditEntry[]): string {
  const header = "id,project_id,credit_quality,green_impact,tx_hash,triggered_by,timestamp";
  const rows = entries.map((e) =>
    [
      e.id,
      e.project_id,
      e.credit_quality,
      e.green_impact,
      e.tx_hash,
      e.triggered_by,
      new Date(e.timestamp).toISOString(),
    ].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

export function clearAuditLog(): void {
  store.length = 0;
  seq = 0;
  maxEntriesOverride = null;
}
