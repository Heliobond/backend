import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { parseContractError } from "./contractErrors";

/**
 * Structured audit logger (#542). Deliberately separate from the application
 * logger in ./logger: entries are one JSON object per line (JSONL) and go to a
 * dedicated sink, so they can be shipped to a SIEM without app-log noise.
 *
 * Sink selection: AUDIT_LOG_FILE=<path> appends to that file, AUDIT_LOG_FILE=stdout
 * writes to process.stdout. Unset -> the file "logs/audit.log", except under
 * NODE_ENV=test where nothing is written unless a sink is set explicitly.
 */
export interface AuditLogEntry {
  timestamp: string;
  action: string;
  correlation_id: string;
  ip: string | null;
  user_agent: string | null;
  project_ids: number[];
  success: boolean;
  results?: unknown;
  error?: string;
  contract_error_name?: string;
  contract_error_code?: number;
}

export type AuditSink = (line: string) => void;

let sinkOverride: AuditSink | null | undefined;

const defaultSink = (): AuditSink | null => {
  const target =
    process.env.AUDIT_LOG_FILE ?? (process.env.NODE_ENV === "test" ? "" : "logs/audit.log");
  if (!target) return null;
  if (target === "stdout") return (line) => void process.stdout.write(line + "\n");
  let ready = false;
  return (line) => {
    if (!ready) {
      mkdirSync(dirname(target), { recursive: true });
      ready = true;
    }
    appendFileSync(target, line + "\n");
  };
};

let cachedDefault: { key: string; sink: AuditSink | null } | undefined;

const resolveSink = (): AuditSink | null => {
  if (sinkOverride !== undefined) return sinkOverride;
  const key = `${process.env.AUDIT_LOG_FILE}|${process.env.NODE_ENV}`;
  if (!cachedDefault || cachedDefault.key !== key) cachedDefault = { key, sink: defaultSink() };
  return cachedDefault.sink;
};

/** Override the sink (tests). Pass undefined to restore env-based selection. */
export function setAuditSink(sink: AuditSink | null | undefined): void {
  sinkOverride = sink;
}

export function writeAuditLog(
  entry: Omit<AuditLogEntry, "timestamp"> & { timestamp?: string },
): AuditLogEntry {
  let contract_error_name = entry.contract_error_name;
  let contract_error_code = entry.contract_error_code;
  if (!contract_error_name && entry.error) {
    const decoded = parseContractError(entry.error);
    if (decoded) {
      contract_error_name = decoded.name;
      contract_error_code = decoded.code;
    }
  }

  const full: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
    ...(contract_error_name !== undefined ? { contract_error_name } : {}),
    ...(contract_error_code !== undefined ? { contract_error_code } : {}),
  };
  try {
    resolveSink()?.(JSON.stringify(full));
  } catch {
    // An unwritable audit sink must never fail the request being audited.
    process.stderr.write(`[audit-logger] failed to write audit entry for ${full.action}\n`);
  }
  return full;
}
