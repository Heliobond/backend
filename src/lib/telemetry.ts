/**
 * Frontend telemetry ingest (#770).
 *
 * The browser sends error reports and Web Vitals measurements to
 * `POST /v1/telemetry`, usually via `navigator.sendBeacon` with a
 * `text/plain` Blob. This module holds the pure pieces of that pipeline:
 *
 *  - the two accepted schemas (`ErrorReport`, `WebVitalReport`),
 *  - hand-rolled runtime guards consistent with the rest of the codebase,
 *  - a second PII scrub pass (Stellar keys, XDR blobs, e-mail addresses),
 *  - a byte-size parser for the route's body limit,
 *  - the optional OTLP forwarder (disabled unless explicitly enabled).
 *
 * Nothing here is persisted; the route only increments Prometheus series and
 * optionally emits a sanitized OpenTelemetry span.
 */

import { config } from "../config";
import { tracer } from "./tracer";

// ── Schemas ─────────────────────────────────────────────────────────────────

/** A frontend runtime/Soroban error report. */
export interface ErrorReport {
  /** Discriminator + metric label, e.g. `runtime`, `unhandledrejection`, `contract`. */
  kind: string;
  /** Human-readable error message (PII-scrubbed before use). */
  message: string;
  /** Optional JS stack trace. */
  stack?: string;
  /** Optional page URL the error occurred on. */
  url?: string;
  /** Optional navigator.userAgent. */
  userAgent?: string;
  /** Optional decoded Soroban error code (number or numeric string). */
  contractErrorCode?: number | string;
  /** Optional Soroban contract error name, used as a metric label. */
  contractErrorName?: string;
  /** Optional epoch-ms timestamp from the client. */
  timestamp?: number;
}

/** A single Web Vitals measurement (LCP/CLS/INP/…). */
export interface WebVitalReport {
  /** Metric name, e.g. `LCP`, `CLS`, `INP`, `FCP`, `TTFB`. */
  name: string;
  /** Metric value (milliseconds, or unitless for CLS). */
  value: number;
  /** Rating buckets reported by web-vitals. */
  rating: WebVitalRating;
  /** Optional measurement id. */
  id?: string;
  /** Optional delta since the previous report. */
  delta?: number;
  /** Optional navigation type. */
  navigationType?: string;
  /** Optional epoch-ms timestamp from the client. */
  timestamp?: number;
}

export type WebVitalRating = "good" | "needs-improvement" | "poor";

export type TelemetryReport =
  { type: "error"; report: ErrorReport } | { type: "web-vital"; report: WebVitalReport };

/** Web Vitals metric names accepted as the `name` label. */
export const WEB_VITAL_NAMES = ["CLS", "FCP", "INP", "LCP", "TTFB", "FID"] as const;

/** Ratings accepted as the `rating` label. */
export const WEB_VITAL_RATINGS: readonly WebVitalRating[] = ["good", "needs-improvement", "poor"];

const MAX_MESSAGE_LENGTH = 8192;
const MAX_STACK_LENGTH = 16384;
const MAX_URL_LENGTH = 2048;
const MAX_USER_AGENT_LENGTH = 1024;
const MAX_LABEL_LENGTH = 64;

/** Safe metric/label vocabulary: bounded length and no whitespace or control chars. */
const SAFE_LABEL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const NUMERIC_RE = /^\d{1,10}$/;

// ── PII scrub ───────────────────────────────────────────────────────────────

/** Stellar account address `G…` (ed25519 public key). */
const STELLAR_ADDRESS_RE = /\bG[A-Z2-7]{55}\b/g;
/** Stellar secret seed `S…` — must never be retained even if a client sends it. */
const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;
/** Stellar contract id `C…`. */
const STELLAR_CONTRACT_RE = /\bC[A-Z2-7]{55}\b/g;
/** XDR / long base64 blobs (transaction envelopes, etc.). */
const XDR_RE = /\b[A-Za-z0-9+/]{120,}={0,2}\b/g;
/** E-mail addresses. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Replace every PII-shaped substring in a single string with a redaction marker. */
export function redactPiiString(value: string): string {
  return value
    .replace(XDR_RE, "[redacted:xdr]")
    .replace(STELLAR_ADDRESS_RE, "[redacted:stellar-address]")
    .replace(STELLAR_SECRET_RE, "[redacted:stellar-secret]")
    .replace(STELLAR_CONTRACT_RE, "[redacted:stellar-contract]")
    .replace(EMAIL_RE, "[redacted:email]");
}

/**
 * Recursively scrub every string in a parsed telemetry payload. Non-string
 * values are returned unchanged; arrays and plain objects are rebuilt.
 */
export function scrubPii(value: unknown): unknown {
  if (typeof value === "string") return redactPiiString(value);
  if (Array.isArray(value)) return value.map((item) => scrubPii(item));
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = scrubPii(item);
    }
    return result;
  }
  return value;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeLabel(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_LABEL_LENGTH && SAFE_LABEL_RE.test(value);
}

function isOptionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isContractErrorCode(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0;
  return typeof value === "string" && NUMERIC_RE.test(value);
}

// ── Guards ──────────────────────────────────────────────────────────────────

/** Runtime guard for the frontend `ErrorReport` schema. */
export function isErrorReport(value: unknown): value is ErrorReport {
  if (!isRecord(value)) return false;
  if (!isSafeLabel(value.kind)) return false;
  if (typeof value.message !== "string") return false;
  if (value.message.length === 0 || value.message.length > MAX_MESSAGE_LENGTH) return false;
  if (!isOptionalBoundedString(value.stack, MAX_STACK_LENGTH)) return false;
  if (!isOptionalBoundedString(value.url, MAX_URL_LENGTH)) return false;
  if (!isOptionalBoundedString(value.userAgent, MAX_USER_AGENT_LENGTH)) return false;
  if (value.contractErrorName !== undefined && !isSafeLabel(value.contractErrorName)) return false;
  if (!isContractErrorCode(value.contractErrorCode)) return false;
  if (!isOptionalFiniteNumber(value.timestamp)) return false;
  return true;
}

/** Runtime guard for the frontend `WebVitalReport` schema. */
export function isWebVitalReport(value: unknown): value is WebVitalReport {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string") return false;
  if (!(WEB_VITAL_NAMES as readonly string[]).includes(value.name)) return false;
  if (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0) {
    return false;
  }
  if (typeof value.rating !== "string") return false;
  if (!WEB_VITAL_RATINGS.includes(value.rating as WebVitalRating)) return false;
  if (value.id !== undefined && typeof value.id !== "string") return false;
  if (!isOptionalFiniteNumber(value.delta)) return false;
  if (value.navigationType !== undefined && typeof value.navigationType !== "string") return false;
  if (!isOptionalFiniteNumber(value.timestamp)) return false;
  return true;
}

/**
 * Classify a scrubbed payload as one of the two accepted report schemas.
 * `ErrorReport` is discriminated by `kind`; `WebVitalReport` by `name`+`value`+`rating`.
 * Returns `null` when the payload matches neither schema.
 */
export function classifyTelemetryReport(value: unknown): TelemetryReport | null {
  if (isErrorReport(value)) return { type: "error", report: value };
  if (isWebVitalReport(value)) return { type: "web-vital", report: value };
  return null;
}

// ── Body size ───────────────────────────────────────────────────────────────

/**
 * Parse a human byte size (`64kb`, `1mb`, `512b`) into bytes. Unparseable
 * values fall back to 64 KiB so the endpoint always keeps a hard bound.
 */
export function parseByteSize(value: string): number {
  const match = /^(\d+)\s*(b|kb|mb)?$/i.exec(value.trim());
  if (!match) return 64 * 1024;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  return amount * multiplier;
}

// ── Optional OTLP forwarder ─────────────────────────────────────────────────

/**
 * Optionally attach an anonymised span for an accepted report. Disabled by
 * default (`TELEMETRY_OTLP_ENABLED=false`); when enabled the span is exported
 * by whatever OpenTelemetry SDK/APM exporter is configured for the process.
 * Only validated, PII-scrubbed label fields are attached.
 */
export function forwardTelemetryToOtlp(classified: TelemetryReport): void {
  if (config.TELEMETRY_OTLP_ENABLED !== "true") return;

  const attributes: Record<string, string | number> =
    classified.type === "error"
      ? {
          "telemetry.type": "error",
          "telemetry.kind": classified.report.kind,
          "telemetry.contract_error_name": classified.report.contractErrorName ?? "none",
        }
      : {
          "telemetry.type": "web-vital",
          "telemetry.name": classified.report.name,
          "telemetry.rating": classified.report.rating,
          "telemetry.value": classified.report.value,
        };

  const span = tracer.startSpan("frontend.telemetry", { attributes });
  span.end();
}
