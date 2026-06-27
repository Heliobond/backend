export interface AuditEntry {
  id: number;
  project_id: number;
  credit_quality: number;
  green_impact: number;
  tx_hash: string;
  triggered_by: string;
  timestamp: number;
}

let seq = 0;
const store: AuditEntry[] = [];

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
  return record;
}

export function getAuditLog(opts: {
  project_id?: number;
  from?: number;
  to?: number;
} = {}): AuditEntry[] {
  return store.filter((e) => {
    if (opts.project_id !== undefined && e.project_id !== opts.project_id) return false;
    if (opts.from !== undefined && e.timestamp < opts.from) return false;
    if (opts.to !== undefined && e.timestamp > opts.to) return false;
    return true;
  });
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
}
