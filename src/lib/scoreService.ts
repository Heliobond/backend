import { getSolarData } from "./iot";
import { fetchSatelliteWithFallback } from "./satellite-sources";
import { computeScores } from "./scoring";
import { detectAnomalies } from "./anomaly";
import { updateImpactScore, RpcDegradedError } from "./registry";
import { generateIdempotencyKey, checkIdempotency, clearIdempotencyStore } from "./idempotency";
import { logger } from "./logger";

/** Exposed for tests — delegates to the central idempotency store. */
export function resetIdempotencyState(): void {
  clearIdempotencyStore();
}

/**
 * Max age (ms) a solar/satellite reading may have before it is considered
 * stale and the on-chain update is skipped. Overridable via
 * STALE_READING_MAX_AGE_MS (default: 2 hours).
 */
export function maxReadingAgeMs(): number {
  const raw = process.env.STALE_READING_MAX_AGE_MS;
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    logger.warn("Invalid STALE_READING_MAX_AGE_MS, falling back to default", {
      STALE_READING_MAX_AGE_MS: raw,
    });
  }
  return 2 * 3_600_000;
}

function readingAgeMs(timestamp: unknown): number | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  return Date.now() - timestamp;
}

export interface ScoreUpdateSuccess {
  status: "success";
  projectId: number;
  creditQuality: number;
  greenImpact: number;
  txHash: string;
}

export interface ScoreUpdateDeferred {
  status: "deferred";
  projectId: number;
  creditQuality: number;
  greenImpact: number;
}

export interface ScoreUpdateError {
  status: "error";
  projectId: number;
  error: string;
}

export interface ScoreUpdateSkipped {
  status: "skipped";
  projectId: number;
  reason: string;
}

export type ScoreUpdateResult =
  | ScoreUpdateSuccess
  | ScoreUpdateDeferred
  | ScoreUpdateSkipped
  | ScoreUpdateError;

/**
 * Fetch IoT + satellite data, compute impact scores, and submit to the
 * Soroban contract for a single project. Returns a discriminated result
 * so callers can decide what side-effects (audit, webhooks, history, etc.)
 * to apply — the service itself stays side-effect-free.
 */
export async function updateScoreForProject(projectId: number): Promise<ScoreUpdateResult> {
  // Generate a deterministic idempotency key for this project/hour and pass it
  // to updateImpactScore, which will reject duplicates via the central store.
  const idempotencyKey = generateIdempotencyKey(projectId);

  // Check at the service layer first — this catches duplicates even when the
  // underlying updateImpactScore is mocked in tests.
  const { isDuplicate, recordedAt } = checkIdempotency(idempotencyKey);
  if (isDuplicate) {
    return {
      status: "error",
      projectId,
      error:
        `duplicate submission rejected — key="${idempotencyKey}" ` +
        `first seen at ${new Date(recordedAt!).toISOString()}`,
    };
  }

  try {
    const solar = getSolarData(projectId);
    const satellite = await fetchSatelliteWithFallback(projectId);

    // ── Freshness gate: never push a score built on stale/degraded inputs ──
    const maxAge = maxReadingAgeMs();
    const solarAge = readingAgeMs((solar as { timestamp?: unknown }).timestamp);
    const satAge = readingAgeMs((satellite as { timestamp?: unknown }).timestamp);
    if (solarAge !== null && solarAge > maxAge) {
      logger.warn(`[score] skipping project ${projectId}: stale solar reading`, { solarAge, maxAge });
      return { status: "skipped", projectId, reason: `stale solar reading (age ${solarAge}ms > max ${maxAge}ms)` };
    }
    if (satAge !== null && satAge > maxAge) {
      logger.warn(`[score] skipping project ${projectId}: stale satellite reading`, { satAge, maxAge });
      return { status: "skipped", projectId, reason: `stale satellite reading (age ${satAge}ms > max ${maxAge}ms)` };
    }
    const dataSource = (satellite as { dataSource?: string }).dataSource;
    if (dataSource === "conservative-fallback") {
      logger.warn(`[score] skipping project ${projectId}: satellite sources down, only conservative fallback available`);
      return { status: "skipped", projectId, reason: "satellite sources unavailable (conservative fallback)" };
    }
    if (dataSource === "cache") {
      logger.warn(`[score] skipping project ${projectId}: only cached satellite data available`);
      return { status: "skipped", projectId, reason: "stale satellite data (served from cache)" };
    }

    // ── Anomaly gate: a dead feed / bad reading must not reach the ledger ──
    const anomalyResult = detectAnomalies(projectId, {
      efficiency_pct: solar.efficiency_pct,
      power_output_kw: solar.power_output_kw,
      forest_density_pct: satellite.forest_density_pct,
      ndvi_score: satellite.ndvi_score,
    });
    const blocking = anomalyResult.anomalies.filter((a) => a.severity === "high");
    if (blocking.length > 0) {
      const detail = blocking.map((a) => `${a.metric}:${a.type}`).join(", ");
      logger.warn(`[score] skipping project ${projectId}: high-severity anomaly`, { detail });
      return { status: "skipped", projectId, reason: `anomalous reading detected (${detail})` };
    }
    for (const alert of anomalyResult.anomalies) {
      logger.warn(`[score] project ${projectId}: non-blocking anomaly`, {
        metric: alert.metric, type: alert.type, severity: alert.severity,
      });
    }

    const scores = computeScores({ solar, satellite });

    let txHash: string;
    try {
      txHash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact, idempotencyKey);
    } catch (updateErr) {
      if (updateErr instanceof RpcDegradedError) {
        return {
          status: "deferred",
          projectId,
          creditQuality: scores.credit_quality,
          greenImpact: scores.green_impact,
        };
      }
      throw updateErr;
    }

    return {
      status: "success",
      projectId,
      creditQuality: scores.credit_quality,
      greenImpact: scores.green_impact,
      txHash,
    };
  } catch (err) {
    return { status: "error", projectId, error: String(err) };
  }
}
