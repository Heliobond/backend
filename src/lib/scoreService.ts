import { getSolarData } from "./iot";
import { fetchSatelliteWithFallback } from "./satellite-sources";
import { computeScores } from "./scoring";
import { updateImpactScore, RpcDegradedError } from "./registry";
import { tryBeginUpdate, markCompleted, markFailed } from "./duplicate-detection";

export interface ScoreUpdateSuccess {
  status: "success";
  projectId: number;
  credit_quality: number;
  green_impact: number;
  txHash: string;
}

export interface ScoreUpdateDeferred {
  status: "deferred";
  projectId: number;
  credit_quality: number;
  green_impact: number;
}

export interface ScoreUpdateSkipped {
  status: "skipped";
  projectId: number;
  reason: string;
}

export interface ScoreUpdateError {
  status: "error";
  projectId: number;
  error: string;
}

export type ScoreUpdateResult =
  ScoreUpdateSuccess | ScoreUpdateDeferred | ScoreUpdateSkipped | ScoreUpdateError;

/**
 * Fetch IoT + satellite data, compute impact scores, and submit to the
 * Soroban contract for a single project. Returns a discriminated result
 * so callers can decide what side-effects (audit, webhooks, history, etc.)
 * to apply — the service itself stays side-effect-free.
 */
export async function updateScoreForProject(projectId: number): Promise<ScoreUpdateResult> {
  const { allowed, reason } = tryBeginUpdate(projectId);
  if (!allowed) {
    return { status: "skipped", projectId, reason: reason! };
  }

  try {
    const solar = getSolarData(projectId);
    const satellite = await fetchSatelliteWithFallback(projectId);
    const scores = computeScores({ solar, satellite });

    let txHash: string;
    try {
      txHash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact);
    } catch (updateErr) {
      if (updateErr instanceof RpcDegradedError) {
        markCompleted(projectId);
        return {
          status: "deferred",
          projectId,
          credit_quality: scores.credit_quality,
          green_impact: scores.green_impact,
        };
      }
      throw updateErr;
    }

    markCompleted(projectId);
    return {
      status: "success",
      projectId,
      credit_quality: scores.credit_quality,
      green_impact: scores.green_impact,
      txHash,
    };
  } catch (err) {
    markFailed(projectId);
    return { status: "error", projectId, error: String(err) };
  }
}
