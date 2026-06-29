import express from "express";
import cors from "cors";
import cron from "node-cron";
import dotenv from "dotenv";
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
import { getSolarData, getSatelliteData } from "./routes/iot";
import { computeScores } from "./lib/scoring";
import { updateImpactScore, getTotalProjects } from "./lib/registry";
import { recordScoreHistory, getHistory } from "./lib/history";
import { sendAlertIfSignificant } from "./lib/email";
import { triggerWebhooks } from "./lib/webhooks";
import { indexer } from "./lib/indexer";
import { getHealth, recordCronRun } from "./lib/health";
import { attachWebSocketServer, broadcastScoreUpdate } from "./lib/websocket";
import { rpcPool } from "./lib/stellar";
import { openApiSpec } from "./lib/swagger";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { publicLimiter, adminLimiter } from "./middleware/rateLimit";
import { versionHeaders, acceptVersion, deprecationHeaders } from "./middleware/versioning";

dotenv.config();
const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// Timezone for all cron schedules. Defaults to UTC so behaviour is identical
// across servers regardless of OS locale. Override with e.g. CRON_TIMEZONE=America/New_York.
const CRON_TIMEZONE = process.env.CRON_TIMEZONE ?? 'UTC'

// Fraction of projects that must fail before we escalate the batch run as an error.
// At or above this threshold a warning is logged; 100% failure is always an error.
const CRON_FAILURE_THRESHOLD = parseFloat(process.env.CRON_FAILURE_THRESHOLD ?? '0.5')

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());
app.use(requestLogger);

// ── Liveness ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json(getHealth()));

// ── Swagger UI at /docs ─────────────────────────────────────────────────────
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));
// Raw OpenAPI spec for tooling
app.get("/docs.json", (_req, res) => res.json(openApiSpec));

// ── v1 routes (current) ──────────────────────────────────────────────────────
const v1 = express.Router();
v1.use(versionHeaders);
v1.use(acceptVersion);

v1.use("/iot", publicLimiter, iotRouter);
v1.use("/admin", adminLimiter, adminRouter);
v1.use("/admin/batch", adminLimiter, batchRouter);
v1.use("/projects", publicLimiter, projectsRouter);
v1.use("/projects/:id/history", publicLimiter, historyRouter);
v1.use("/projects/aggregate", publicLimiter, aggregateRouter);
v1.use("/portfolio", publicLimiter, portfolioRouter);
v1.use("/roles", adminLimiter, rolesRouter);
v1.use("/webhooks", adminLimiter, webhooksRouter);
v1.use("/panels", adminLimiter, panelsRouter);
v1.use("/metadata", adminLimiter, metadataRouter);
v1.use("/dashboard", publicLimiter, dashboardRouter);
v1.use("/email", adminLimiter, emailRouter);
v1.use("/anomaly", publicLimiter, anomalyRouter);
v1.use("/scoring/formulas", adminLimiter, scoringFormulasRouter);
v1.use("/chains", adminLimiter, chainsRouter);
v1.use("/satellite-sources", adminLimiter, satelliteSourcesRouter);
v1.use("/comparison", publicLimiter, comparisonRouter);
v1.use("/benchmarking", publicLimiter, benchmarkingRouter);
v1.use("/financial", publicLimiter, financialRouter);
v1.use("/forecast", publicLimiter, forecastRouter);
v1.use("/maintenance", publicLimiter, maintenanceRouter);
v1.use("/investor", publicLimiter, investorRouter);
v1.use("/admin/api-keys", adminLimiter, apiKeysRouter);

app.use("/v1", v1);

// ── Legacy /api paths (deprecated) ──────────────────────────────────────────
// Kept for backward compatibility; will be removed after 2027-01-01.
app.use("/api", deprecationHeaders, versionHeaders);
app.use("/api/iot", publicLimiter, iotRouter);
app.use("/api/admin", adminLimiter, adminRouter);
app.use("/api/admin/batch", adminLimiter, batchRouter);
app.use("/api/projects", publicLimiter, projectsRouter);
app.use("/api/projects/:id/history", publicLimiter, historyRouter);
app.use("/api/projects/aggregate", publicLimiter, aggregateRouter);
app.use("/api/portfolio", publicLimiter, portfolioRouter);
app.use("/api/roles", adminLimiter, rolesRouter);
app.use("/api/webhooks", adminLimiter, webhooksRouter);
app.use("/api/panels", adminLimiter, panelsRouter);
app.use("/api/metadata", adminLimiter, metadataRouter);
app.use("/api/dashboard", publicLimiter, dashboardRouter);
app.use("/api/email", adminLimiter, emailRouter);
app.use("/api/comparison", publicLimiter, comparisonRouter);
app.use("/api/benchmarking", publicLimiter, benchmarkingRouter);
app.use("/api/financial", publicLimiter, financialRouter);
app.use("/api/forecast", publicLimiter, forecastRouter);
app.use("/api/maintenance", publicLimiter, maintenanceRouter);
app.use("/api/investor", publicLimiter, investorRouter);
app.use("/api/admin/api-keys", adminLimiter, apiKeysRouter);

// JSON 404 for anything unmatched, then the structured error handler.
app.use(notFoundHandler);
app.use(errorHandler);

// ── Cron: index contract events every 5 minutes ──────────────────────────────
cron.schedule("*/5 * * * *", async () => {
  try {
    console.log("[cron] indexing new events");
    await indexer.poll();
    recordCronRun("indexer", "success");
  } catch (err) {
    console.error("[cron] indexer poll failed:", err);
    recordCronRun("indexer", "error");
  }
}, { timezone: CRON_TIMEZONE });

// ── Cron: hourly score update ────────────────────────────────────────────────
cron.schedule("0 * * * *", async () => {
  try {
    console.log("[cron] running hourly score update");
    const total = await getTotalProjects();
    const projectIds = Array.from({ length: total }, (_, i) => i + 1);

    let successCount = 0
    let failureCount = 0

    for (const projectId of projectIds) {
      try {
        const solar = getSolarData(projectId);
        const satellite = getSatelliteData(projectId);
        const scores = computeScores({ solar, satellite });
        const tx_hash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact);
        recordScoreHistory(projectId, scores.credit_quality, scores.green_impact);
        triggerWebhooks({ project_id: projectId, ...scores, tx_hash, timestamp: Date.now() });

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
        triggerWebhooks({ project_id: projectId, ...scores, tx_hash, timestamp });
        broadcastScoreUpdate({ project_id: projectId, ...scores, timestamp });
        console.log(`[cron] project ${projectId}: cq=${scores.credit_quality} gi=${scores.green_impact} tx=${tx_hash}`);
        successCount++
      } catch (err) {
        console.error(`[cron] project ${projectId} failed:`, err);
        failureCount++
      }
    }

    const totalProcessed = successCount + failureCount
    const failureRate = totalProcessed > 0 ? failureCount / totalProcessed : 0

    if (totalProcessed > 0 && failureCount === totalProcessed) {
      // All projects failed — likely a systemic issue (RPC outage, bad contract state).
      // Record as an error so health checks and monitors can react.
      console.error(
        `[cron] ALERT: ALL ${failureCount} projects failed in score-update batch — ` +
        `check Soroban RPC connectivity and contract state`
      )
      recordCronRun("score-update", "error")
    } else {
      if (failureCount > 0 && failureRate >= CRON_FAILURE_THRESHOLD) {
        console.error(
          `[cron] WARN: high failure rate in score-update batch: ` +
          `${failureCount}/${totalProcessed} (${(failureRate * 100).toFixed(1)}%)`
        )
      }
      console.log(`[cron] score-update complete: ${successCount} succeeded, ${failureCount} failed`)
      recordCronRun("score-update", "success")
    }
  } catch (err) {
    console.error("[cron] score update failed:", err);
    recordCronRun("score-update", "error");
  }
}, { timezone: CRON_TIMEZONE });

const server = app.listen(PORT, () => {
  console.log(`Heliobond backend listening on port ${PORT}`);
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
  })
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
  console.log(`[${signal}] shutting down gracefully…`);
  server.close(async () => {
    try {
      await rpcPool.shutdown();
      console.log("[shutdown] connection pool drained");
    } catch (err) {
      console.error("[shutdown] pool drain error:", err);
    } finally {
      process.exit(0);
    }
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;
