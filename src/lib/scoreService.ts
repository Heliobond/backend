import { getSolarData } from "./iot";
import { fetchSatelliteWithFallback } from "./satellite-sources";
import { computeScores } from "./scoring";
import { updateImpactScore, RpcDegradedError } from "./registry";

const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS ?? 60_000);
const seenSubmissions = new Map<string, number>();

function getIdempotencyKey(projectId: number, now: number): string {
  const bucket = Math.floor(now / Math.max(IDEMPOTENCY_TTL_MS, 1));
  return `score:${projectId}:${bucket}`;
}

function isDuplicateSubmission(key: string, now: number): boolean {
  const previous = seenSubmissions.get(key);
  return previous !== undefined && now - previous < IDEMPOTENCY_TTL_MS;
}

export function resetIdempotencyState(): void {
  seenSubmissions.clear();
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
  const now = Date.now();
  const idempotencyKey = getIdempotencyKey(projectId, now);

  if (isDuplicateSubmission(idempotencyKey, now)) {
    return { status: "error", projectId, error: "Duplicate submission rejected by idempotency key" };
  }

  seenSubmissions.set(idempotencyKey, now);

  try {
    const solar = getSolarData(projectId);
    const satellite = await fetchSatelliteWithFallback(projectId);
    const scores = computeScores({ solar, satellite });

    let txHash: string;
    try {
      txHash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact);
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
