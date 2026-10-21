import { Router, Request, Response, NextFunction } from "express";
import { register } from "../lib/prometheus";
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
    const metrics = await register.metrics();
    const lines = metrics.split("\n");

    // Parse metrics from Prometheus format
    let signerBalance: number | null = null;
    let registryPaused = false;
    const scoreAges: number[] = [];
    let successCount = 0;
    let failureCount = 0;
    const buckets: { le: number; count: number }[] = [];

    for (const line of lines) {
      if (line.startsWith("#") || line.trim() === "") continue;

      // Parse signer balance
      if (line.startsWith("oracle_signer_balance_xlm ")) {
        signerBalance = parseFloat(line.split(" ")[1]);
      }

      // Parse registry paused state
      if (line.startsWith("registry_paused ")) {
        registryPaused = parseFloat(line.split(" ")[1]) === 1;
      }

      // Parse score ages
      if (line.startsWith("oracle_score_age_seconds{")) {
        const value = parseFloat(line.split(" ")[1]);
        if (!isNaN(value)) {
          scoreAges.push(value);
        }
      }

      // Parse submission totals for success rate
      if (line.includes('stellar_tx_submissions_total{result="success"}')) {
        successCount = parseFloat(line.split(" ")[1]) || 0;
      }
      if (line.includes('stellar_tx_submissions_total{result="failure"}')) {
        failureCount = parseFloat(line.split(" ")[1]) || 0;
      }

      // Parse submission latency histogram buckets
      if (line.startsWith("oracle_submit_to_confirm_latency_seconds_bucket{")) {
        const leMatch = line.match(/le="([^"]+)"/);
        const parts = line.split(" ");
        const countVal = parseFloat(parts[parts.length - 1]);
        if (leMatch && !isNaN(countVal)) {
          const le = leMatch[1] === "+Inf" ? Infinity : parseFloat(leMatch[1]);
          buckets.push({ le, count: countVal });
        }
      }
    }

    // Calculate percentiles for score ages
    const sortedAges = scoreAges.sort((a, b) => a - b);
    const p50Age = percentile(sortedAges, 0.5);
    const p95Age = percentile(sortedAges, 0.95);
    const p99Age = percentile(sortedAges, 0.99);

    // Count stale projects (>2 hours)
    const staleProjects = scoreAges.filter((age) => age > 7200).length;

    // Calculate success rate
    const totalSubmissions = successCount + failureCount;
    const successRate = totalSubmissions > 0 ? successCount / totalSubmissions : null;

    // Calculate latency percentiles from histogram buckets
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
