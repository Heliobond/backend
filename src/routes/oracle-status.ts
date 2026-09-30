import { Router, Request, Response, NextFunction } from "express";
import { register } from "../lib/prometheus";
import { logger } from "../lib/logger";

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
  submission_success_rate_7d: number | null;
  submit_latency: {
    p50_seconds: number | null;
    p95_seconds: number | null;
    p99_seconds: number | null;
  };
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
    const submitLatencies: number[] = [];

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
    }

    // Calculate percentiles for score ages
    const sortedAges = scoreAges.sort((a, b) => a - b);
    const p50Age = percentile(sortedAges, 0.5);
    const p95Age = percentile(sortedAges, 0.95);
    const p99Age = percentile(sortedAges, 0.99);

    // Count stale projects (>2 hours)
    const staleProjects = scoreAges.filter((age) => age > 7200).length;

    // Calculate 7-day success rate (using current counters as proxy)
    const totalSubmissions = successCount + failureCount;
    const successRate = totalSubmissions > 0 ? successCount / totalSubmissions : null;

    // For latency percentiles, we'd need to query histogram buckets
    // For now, return null (would require more complex parsing)
    const status: OracleStatus = {
      signer_balance_xlm: signerBalance,
      registry_paused: registryPaused,
      score_freshness: {
        p50_age_seconds: p50Age,
        p95_age_seconds: p95Age,
        p99_age_seconds: p99Age,
        stale_projects: staleProjects,
        total_projects: scoreAges.length,
      },
      submission_success_rate_7d: successRate,
      submit_latency: {
        p50_seconds: null,
        p95_seconds: null,
        p99_seconds: null,
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
