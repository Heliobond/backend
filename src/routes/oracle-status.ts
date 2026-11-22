import { Router, Request, Response, NextFunction } from "express";
import {
  oracleSignerBalance,
  registryPaused as registryPausedGauge,
  oracleScoreAge,
  txSubmissionTotal,
  oracleSubmitLatency,
} from "../lib/prometheus";
import { logger } from "../lib/logger";
import { getTotalProjects } from "../lib/registry";

const router = Router();

interface OracleStatus {
  signer_balance_xlm: number | null;
  registry_paused: boolean;
  score_freshness: {
    p50_age_seconds: number | null;
    p95_age_seconds: number | null;
    p99_age_seconds: number | null;
    stale_projects: number;
    total_projects: number;
  };
  submission_success_rate: number | null;
  submission_success_rate_7d: number | null;
  submit_latency: {
    p50_seconds: number | null;
    p95_seconds: number | null;
    p99_seconds: number | null;
  };
}

function percentileFromBuckets(buckets: { le: number; count: number }[], q: number): number | null {
  if (buckets.length === 0) return null;
  const leMap = new Map<number, number>();
  for (const b of buckets) {
    leMap.set(b.le, (leMap.get(b.le) ?? 0) + b.count);
  }
  const sorted = Array.from(leMap.entries())
    .map(([le, count]) => ({ le, count }))
    .sort((a, b) => a.le - b.le);

  const total =
    sorted.find((b) => b.le === Infinity)?.count ?? sorted[sorted.length - 1]?.count ?? 0;
  if (total === 0) return null;

  const target = q * total;
  for (const b of sorted) {
    if (b.count >= target && Number.isFinite(b.le)) {
      return b.le;
    }
  }
  return sorted.filter((b) => Number.isFinite(b.le)).pop()?.le ?? null;
}

/**
 * GET /v1/status/oracle
 *
 * Returns a summary of oracle health for frontend status badges and dashboards.
 * Aggregates Prometheus metrics into percentiles and rates.
 */
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Read structured registry values directly instead of parsing serialized
    // metric text (#1062). Text parsing is fragile: the default `app` label
    // added by the registry, additional labels, or label reordering all cause
    // exact-string patterns to silently miss their targets.

    // Signer balance: single unlabelled gauge
    const signerBalanceData = await oracleSignerBalance.get();
    const signerBalance: number | null =
      signerBalanceData.values.length > 0 ? (signerBalanceData.values[0].value ?? null) : null;

    // Registry paused: single unlabelled gauge (1 = paused)
    const pausedData = await registryPausedGauge.get();
    const registryPaused = (pausedData.values[0]?.value ?? 0) === 1;

    // Score ages: one labelled gauge per project
    const ageData = await oracleScoreAge.get();
    const scoreAges = ageData.values.map((v) => v.value);
    const sortedAges = [...scoreAges].sort((a, b) => a - b);
    const p50Age = percentile(sortedAges, 0.5);
    const p95Age = percentile(sortedAges, 0.95);
    const p99Age = percentile(sortedAges, 0.99);
    const staleProjects = scoreAges.filter((age) => age > 7200).length;

    // Submission totals: labelled counter — look up by label value, not string position
    const subData = await txSubmissionTotal.get();
    const successCount =
      subData.values.find((v) => (v.labels as Record<string, string>).result === "success")
        ?.value ?? 0;
    const failureCount =
      subData.values.find((v) => (v.labels as Record<string, string>).result === "failure")
        ?.value ?? 0;
    const totalSubmissions = successCount + failureCount;
    const successRate = totalSubmissions > 0 ? successCount / totalSubmissions : null;

    // Latency histogram: use the structured bucket values
    const latencyData = await oracleSubmitLatency.get();
    const buckets: { le: number; count: number }[] = latencyData.values
      .filter((v) => (v.labels as Record<string, string>).le !== undefined)
      .map((v) => ({
        le: (v.labels as Record<string, string>).le === "+Inf"
          ? Infinity
          : parseFloat((v.labels as Record<string, string>).le),
        count: v.value,
      }));
    const p50Latency = percentileFromBuckets(buckets, 0.5);
    const p95Latency = percentileFromBuckets(buckets, 0.95);
    const p99Latency = percentileFromBuckets(buckets, 0.99);

    const totalProjects = await getTotalProjects();

    const status: OracleStatus = {
      signer_balance_xlm: signerBalance,
      registry_paused: registryPaused,
      score_freshness: {
        p50_age_seconds: p50Age,
        p95_age_seconds: p95Age,
        p99_age_seconds: p99Age,
        stale_projects: staleProjects,
        total_projects: totalProjects,
      },
      submission_success_rate: successRate,
      submission_success_rate_7d: successRate,
      submit_latency: {
        p50_seconds: p50Latency,
        p95_seconds: p95Latency,
        p99_seconds: p99Latency,
      },
    };

    res.json(status);
  } catch (error) {
    logger.error("[oracle-status] error", logger.formatError(error));
    next(error);
  }
});

/**
 * Calculate percentile from sorted array
 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)];
}

export default router;
