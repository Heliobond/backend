import express from "express";
import cors from "cors";
import cron from "node-cron";
import dotenv from "dotenv";
import { initEnv } from "./lib/env";
import swaggerUi from "swagger-ui-express";
import iotRouter from "./routes/iot";
import adminRouter from "./routes/admin";
import projectsRouter from "./routes/projects";
import portfolioRouter from "./routes/portfolio";
import rolesRouter from "./routes/roles";
import batchRouter from "./routes/batch";
import webhooksRouter from "./routes/webhooks";
import historyRouter from "./routes/history";
import panelsRouter from "./routes/panels";
import metadataRouter from "./routes/metadata";
import dashboardRouter from "./routes/dashboard";
import emailRouter from "./routes/email";
import anomalyRouter from "./routes/anomaly";
import scoringFormulasRouter from "./routes/scoring-formulas";
import chainsRouter from "./routes/chains";
import satelliteSourcesRouter from "./routes/satellite-sources";
import aggregateRouter from "./routes/aggregate";
import comparisonRouter from "./routes/comparison";
import benchmarkingRouter from "./routes/benchmarking";
import financialRouter from "./routes/financial";
import forecastRouter from "./routes/forecast";
import maintenanceRouter from "./routes/maintenance";
import investorRouter from "./routes/investor";
import apiKeysRouter from "./routes/apiKeys";
import { createHandler } from "graphql-http/lib/use/express";
import { graphqlSchema, graphqlRoot, createGraphQLContext } from "./graphql/schema";
import { startGrpcServer } from "./grpc/server";
import { getSolarData } from "./routes/iot";
import { fetchSatelliteWithFallback } from "./lib/satellite-sources";
import { computeScores } from "./lib/scoring";
import { updateImpactScore, getTotalProjects, RpcDegradedError } from "./lib/registry";
import { recordScoreHistory, getHistory } from "./lib/history";
import { tryBeginUpdate, markCompleted, markFailed } from "./lib/duplicate-detection";
import { isErrorRateLimited, resetErrorRateLimit } from "./lib/error-limiter";
import { isRpcOutageExtended, isRpcAvailable, getRpcStatus } from "./lib/stellar";
import {
  enqueue,
  getQueueSize,
  dequeue,
  remove,
  incrementRetry,
  hasExceededMaxRetries,
} from "./lib/tx-queue";
import { sendAlertIfSignificant } from "./lib/email";
import { triggerWebhooks } from "./lib/webhooks";
import { indexer } from "./lib/indexer";
import { getHealth, getReadiness, recordCronRun } from "./lib/health";
import { attachWebSocketServer, broadcastScoreUpdate } from "./lib/websocket";
import { rpcPool } from "./lib/stellar";
import { openApiSpec } from "./lib/swagger";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { sanitizeInputs } from "./middleware/sanitize";
import { securityHeaders } from "./middleware/securityHeaders";
import { publicLimiter, adminLimiter } from "./middleware/rateLimit";
import { versionHeaders, acceptVersion, deprecationHeaders } from "./middleware/versioning";
import { runWithCorrelationId, generateCorrelationId } from "./lib/correlation";
import { logger } from "./lib/logger";
import { getTraces, getTraceSummary } from "./lib/tracer";
import { withProjectLock } from "./lib/request-queue";
import { checkScheduledRotations } from "./lib/apiKeys";
import { ipWhitelist } from "./middleware/ipWhitelist";
import { requestSigning } from "./middleware/requestSigning";
import { initApm } from "./lib/apm";

dotenv.config();
const env = initEnv();

// Initialize APM before any other imports
await initApm();

const app = express();
const PORT = env.PORT;

// Timezone for all cron schedules. Defaults to UTC so behaviour is identical
// across servers regardless of OS locale. Override with e.g. CRON_TIMEZONE=America/New_York.
const CRON_TIMEZONE = process.env.CRON_TIMEZONE ?? "UTC";

// Fraction of projects that must fail before we escalate to a warning.
// 100% failure is always recorded as an error regardless of this threshold.
const CRON_FAILURE_THRESHOLD = parseFloat(process.env.CRON_FAILURE_THRESHOLD ?? "0.5");

app.use(securityHeaders);
app.use(cors({ origin: env.FRONTEND_URL }));
app.use(express.json());
app.use(sanitizeInputs);
app.use(requestLogger);

// ── Liveness ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json(getHealth()));

// ── Readiness ────────────────────────────────────────────────────────────────
app.get("/ready", (_req, res) => {
  const readiness = getReadiness();
  res.status(readiness.status === "ready" ? 200 : 503).json(readiness);
});

// ── Trace export ─────────────────────────────────────────────────────────────
app.get("/v1/traces", adminLimiter, (req, res) => {
  const correlationId = req.query.correlation_id as string | undefined;
  const limit = Math.min(parseInt((req.query.limit as string) || "100", 10), 500);
  const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
  res.json({
    summary: getTraceSummary(),
    spans: getTraces({ correlationId, limit, since }),
  });
});

// ── Swagger UI at /docs ─────────────────────────────────────────────────────
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));
// Raw OpenAPI spec for tooling
app.get("/docs.json", (_req, res) => res.json(openApiSpec));

// ── v1 routes (current) ──────────────────────────────────────────────────────
const v1 = express.Router();
v1.use(versionHeaders);
v1.use(acceptVersion);

v1.use("/iot", publicLimiter, iotRouter);
v1.use("/admin", ipWhitelist, adminLimiter, requestSigning, adminRouter);
v1.use("/admin/batch", ipWhitelist, adminLimiter, batchRouter);
v1.use("/projects", publicLimiter, projectsRouter);
v1.use("/projects/:id/history", publicLimiter, historyRouter);
v1.use("/projects/aggregate", publicLimiter, aggregateRouter);
v1.use("/portfolio", publicLimiter, portfolioRouter);
v1.use("/roles", ipWhitelist, adminLimiter, rolesRouter);
v1.use("/webhooks", ipWhitelist, adminLimiter, webhooksRouter);
v1.use("/panels", ipWhitelist, adminLimiter, panelsRouter);
v1.use("/metadata", ipWhitelist, adminLimiter, metadataRouter);
v1.use("/dashboard", publicLimiter, dashboardRouter);
v1.use("/email", ipWhitelist, adminLimiter, emailRouter);
v1.use("/anomaly", publicLimiter, anomalyRouter);
v1.use("/scoring/formulas", ipWhitelist, adminLimiter, scoringFormulasRouter);
v1.use("/chains", ipWhitelist, adminLimiter, chainsRouter);
v1.use("/satellite-sources", ipWhitelist, adminLimiter, satelliteSourcesRouter);
v1.use("/comparison", publicLimiter, comparisonRouter);
v1.use("/benchmarking", publicLimiter, benchmarkingRouter);
v1.use("/financial", publicLimiter, financialRouter);
v1.use("/forecast", publicLimiter, forecastRouter);
v1.use("/maintenance", publicLimiter, maintenanceRouter);
v1.use("/investor", publicLimiter, investorRouter);
v1.use("/admin/api-keys", ipWhitelist, adminLimiter, apiKeysRouter);

app.use("/v1", v1);

// ── Legacy /api paths (deprecated) ──────────────────────────────────────────
// Kept for backward compatibility; will be removed after 2027-01-01.
app.use("/api", deprecationHeaders, versionHeaders);
app.use("/api/iot", publicLimiter, iotRouter);
app.use("/api/admin", ipWhitelist, adminLimiter, adminRouter);
app.use("/api/admin/batch", ipWhitelist, adminLimiter, batchRouter);
app.use("/api/projects", publicLimiter, projectsRouter);
app.use("/api/projects/:id/history", publicLimiter, historyRouter);
app.use("/api/projects/aggregate", publicLimiter, aggregateRouter);
app.use("/api/portfolio", publicLimiter, portfolioRouter);
app.use("/api/roles", ipWhitelist, adminLimiter, rolesRouter);
app.use("/api/webhooks", ipWhitelist, adminLimiter, webhooksRouter);
app.use("/api/panels", ipWhitelist, adminLimiter, panelsRouter);
app.use("/api/metadata", ipWhitelist, adminLimiter, metadataRouter);
app.use("/api/dashboard", publicLimiter, dashboardRouter);
app.use("/api/email", ipWhitelist, adminLimiter, emailRouter);
app.use("/api/comparison", publicLimiter, comparisonRouter);
app.use("/api/benchmarking", publicLimiter, benchmarkingRouter);
app.use("/api/financial", publicLimiter, financialRouter);
app.use("/api/forecast", publicLimiter, forecastRouter);
app.use("/api/maintenance", publicLimiter, maintenanceRouter);
app.use("/api/investor", publicLimiter, investorRouter);
app.use("/api/admin/api-keys", ipWhitelist, adminLimiter, apiKeysRouter);

// JSON 404 for anything unmatched, then the structured error handler.
app.use(notFoundHandler);
app.use(errorHandler);

// ── Cron: index contract events every 5 minutes ──────────────────────────────
cron.schedule(
  "*/5 * * * *",
  async () => {
    try {
      console.log("[cron] indexing new events");
      await indexer.poll();
      recordCronRun("indexer", "success");
    } catch (err) {
      if (!isErrorRateLimited("cron:indexer")) {
        console.error("[cron] indexer poll failed:", err);
      }
      recordCronRun("indexer", "error");
    }
  },
  { timezone: CRON_TIMEZONE },
);

// ── Cron: hourly score update ────────────────────────────────────────────────
cron.schedule(
  "0 * * * *",
  async () => {
    try {
      console.log("[cron] running hourly score update");
      const total = await getTotalProjects();
      const projectIds = Array.from({ length: total }, (_, i) => i + 1);

      let successCount = 0;
      let failureCount = 0;

      for (const projectId of projectIds) {
        await withProjectLock(projectId, async () => {
          const { allowed, key, reason } = tryBeginUpdate(projectId);
          if (!allowed) {
            console.log(`[cron] skipping project ${projectId}: ${reason}`);
            return;
          }
          try {
            const solar = getSolarData(projectId);
            const satellite = await fetchSatelliteWithFallback(projectId);
            if (satellite.dataSource !== "live") {
              logger.warn("[cron] satellite data degraded", {
                projectId,
                dataSource: satellite.dataSource,
                source: satellite.source,
              });
            }
            const scores = computeScores({ solar, satellite });
            let tx_hash: string | undefined;
            try {
              tx_hash = await updateImpactScore(
                projectId,
                scores.credit_quality,
                scores.green_impact,
              );
            } catch (updateErr) {
              if (updateErr instanceof RpcDegradedError) {
                console.warn(`[cron] project ${projectId}: RPC degraded, score queued for later`);
                enqueue(projectId, scores.credit_quality, scores.green_impact, "RPC degraded");
              } else {
                throw updateErr;
              }
            }
            recordScoreHistory(projectId, scores.credit_quality, scores.green_impact);
            triggerWebhooks({
              project_id: projectId,
              ...scores,
              tx_hash: tx_hash ?? "deferred",
              timestamp: Date.now(),
            });

            // Email alert when this update moved scores significantly (#22).
            const recent = getHistory(projectId).slice(-2);
            if (recent.length === 2) {
              await sendAlertIfSignificant({
                project_id: projectId,
                credit_quality_delta: recent[1].credit_quality - recent[0].credit_quality,
                green_impact_delta: recent[1].green_impact - recent[0].green_impact,
              });
            }
            const timestamp = Date.now();
            recordScoreHistory(projectId, scores.credit_quality, scores.green_impact, timestamp);
            triggerWebhooks({
              project_id: projectId,
              ...scores,
              tx_hash: tx_hash ?? "deferred",
              timestamp,
            });
            broadcastScoreUpdate({ project_id: projectId, ...scores, timestamp });
            if (tx_hash) {
              console.log(
                `[cron] project ${projectId}: cq=${scores.credit_quality} gi=${scores.green_impact} tx=${tx_hash}`,
              );
            } else {
              console.log(
                `[cron] project ${projectId}: cq=${scores.credit_quality} gi=${scores.green_impact} (queued)`,
              );
            }
            markCompleted(projectId);
            resetErrorRateLimit(`cron:project-${projectId}`);
            successCount++;
          } catch (err) {
            markFailed(projectId);
            if (!isErrorRateLimited(`cron:project-${projectId}`)) {
              console.error(`[cron] project ${projectId} failed:`, err);
            }
            failureCount++;
          }
        });
      }

      const totalProcessed = successCount + failureCount;
      const failureRate = totalProcessed > 0 ? failureCount / totalProcessed : 0;

      if (totalProcessed > 0 && failureCount === totalProcessed) {
        // All attempted projects failed — likely a systemic RPC or contract issue.
        console.error(
          `[cron] ALERT: ALL ${failureCount} projects failed in score-update batch — ` +
            `check Soroban RPC connectivity and contract state`,
        );
        recordCronRun("score-update", "error");
      } else {
        if (failureCount > 0 && failureRate >= CRON_FAILURE_THRESHOLD) {
          console.error(
            `[cron] WARN: high failure rate in score-update batch: ` +
              `${failureCount}/${totalProcessed} (${(failureRate * 100).toFixed(1)}%)`,
          );
        }
        logger.info("[cron] hourly score update complete", { total, successCount, failureCount });
        recordCronRun("score-update", "success");
      }
    } catch (err: any) {
      if (!isErrorRateLimited("cron:score-update")) {
        logger.error("[cron] score update failed", { error: err?.message });
      }
      recordCronRun("score-update", "error");
    }
  },
  { timezone: CRON_TIMEZONE },
);

// ── Cron: retry queued transactions every 5 minutes ──────────────────────────
cron.schedule(
  "*/5 * * * *",
  async () => {
    if (getQueueSize() === 0) return;

    if (!isRpcAvailable()) {
      console.log(`[cron] tx-queue: RPC unavailable, ${getQueueSize()} transactions pending`);
      return;
    }

    console.log(`[cron] tx-queue: processing ${getQueueSize()} queued transactions`);
    const maxRetries = 10;
    const processed: number[] = [];

    while (getQueueSize() > 0) {
      const item = dequeue();
      if (!item) break;

      try {
        const solar = getSolarData(item.projectId);
        const satellite = await fetchSatelliteWithFallback(item.projectId);
        const fresh = computeScores({ solar, satellite });

        const tx_hash = await updateImpactScore(
          item.projectId,
          fresh.credit_quality,
          fresh.green_impact,
        );
        processed.push(item.projectId);
        console.log(
          `[cron] tx-queue: project ${item.projectId} retried successfully tx=${tx_hash}`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        incrementRetry(item.projectId, errMsg);

        if (hasExceededMaxRetries(item.projectId)) {
          console.error(
            `[cron] tx-queue: project ${item.projectId} exceeded max retries (${maxRetries}), dropping`,
          );
          remove(item.projectId);
        } else {
          console.warn(
            `[cron] tx-queue: project ${item.projectId} retry failed (attempt ${item.retryCount + 1}), will retry`,
          );
        }
      }
    }

    if (processed.length > 0) {
      console.log(`[cron] tx-queue: successfully retried ${processed.length} transactions`);
    }
  },
  { timezone: CRON_TIMEZONE },
);

// ── Cron: alert on extended RPC outage (every 5 minutes) ────────────────────
cron.schedule(
  "*/5 * * * *",
  async () => {
    if (isRpcOutageExtended(300_000)) {
      const status = getRpcStatus();
      console.error(
        `[alert] Stellar RPC outage detected: ` +
          `consecutiveFailures=${status.consecutiveFailures}, ` +
          `outageDurationMs=${status.outageDurationMs}, ` +
          `lastSuccessAgoMs=${status.lastSuccessAgoMs}`,
      );
    }
  },
  { timezone: CRON_TIMEZONE },
);

// ── Cron: check API key rotations every hour ────────────────────────────────
cron.schedule(
  "0 * * * *",
  () => {
    try {
      const rotated = checkScheduledRotations();
      if (rotated.length > 0) {
        logger.info("[cron] API key rotations executed", {
          count: rotated.length,
          key_ids: rotated.map((k) => k.id),
        });
      }
    } catch (err: any) {
      if (!isErrorRateLimited("cron:api-key-rotation")) {
        logger.error("[cron] API key rotation check failed", { error: err?.message });
      }
      recordCronRun("api-key-rotation", "error");
    }
  },
  { timezone: CRON_TIMEZONE },
);

const server = app.listen(PORT, () => {
  logger.info(`Heliobond backend listening on port ${PORT}`);
});

// Real-time score updates over WebSocket (ws://<host>/ws)
attachWebSocketServer(server);

// GraphQL endpoint and playground setup
app.all(
  "/graphql",
  createHandler({
    schema: graphqlSchema,
    rootValue: graphqlRoot,
    context: (req: any) => createGraphQLContext(req.raw) as any,
  }),
);

app.get("/graphql-playground", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>GraphiQL</title>
        <link href="https://unpkg.com/graphiql/graphiql.min.css" rel="stylesheet" />
      </head>
      <body style="margin: 0;">
        <div id="graphiql" style="height: 100vh;"></div>
        <script crossorigin src="https://unpkg.com/react/umd/react.production.min.js"></script>
        <script crossorigin src="https://unpkg.com/react-dom/umd/react-dom.production.min.js"></script>
        <script crossorigin src="https://unpkg.com/graphiql/graphiql.min.js"></script>
        <script>
          const fetcher = GraphiQL.createFetcher({ url: '/graphql' });
          ReactDOM.render(
            React.createElement(GraphiQL, { fetcher: fetcher }),
            document.getElementById('graphiql'),
          );
        </script>
      </body>
    </html>
  `);
});

// Start high-performance gRPC server
startGrpcServer(50051);

// Graceful shutdown: drain the connection pool before exiting
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`[${signal}] shutting down gracefully…`);
  server.close(async () => {
    try {
      await rpcPool.shutdown();
      logger.info("[shutdown] connection pool drained");
    } catch (err: any) {
      logger.error("[shutdown] pool drain error", { error: err?.message });
    } finally {
      process.exit(0);
    }
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;
