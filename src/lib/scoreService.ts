import { getSolarData } from "./iot";
import { fetchSatelliteWithFallback } from "./satellite-sources";
import { computeScores } from "./scoring";
import { updateImpactScore, RpcDegradedError } from "./registry";
import { generateIdempotencyKey, checkIdempotency, clearIdempotencyStore } from "./idempotency";

/** Exposed for tests — delegates to the central idempotency store. */
export function resetIdempotencyState(): void {
  clearIdempotencyStore();
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

export type ScoreUpdateResult = ScoreUpdateSuccess | ScoreUpdateDeferred | ScoreUpdateError;

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
