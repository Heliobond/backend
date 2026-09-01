import express from "express";
import cors from "cors";
import cron, { ScheduledTask } from "node-cron";
import { config, initEnv } from "./config";
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
import { getSolarData } from "./lib/iot";
import { fetchSatelliteWithFallback } from "./lib/satellite-sources";
import { computeScores } from "./lib/scoring";
import { updateImpactScore } from "./lib/registry";
import { runHourlyScoreUpdate } from "./lib/scoreUpdateCron";
import { isErrorRateLimited } from "./lib/error-limiter";
import { isRpcOutageExtended, isRpcAvailable, getRpcStatus } from "./lib/stellar";
import {
  getQueueSize,
  dequeue,
  remove,
  incrementRetry,
  hasExceededMaxRetries,
} from "./lib/tx-queue";
import { indexer } from "./lib/indexer";
import { getHealth, getReadiness, recordCronRun } from "./lib/health";
import { getMetrics } from "./lib/metrics";
import { register } from "./lib/prometheus";
import { prometheusMiddleware } from "./middleware/prometheusMiddleware";
import { attachWebSocketServer } from "./lib/websocket";
import { rpcPool } from "./lib/stellar";
import { openApiSpec } from "./lib/swagger";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { sanitizeInputs } from "./middleware/sanitize";
import { securityHeaders, permissionsHeaders } from "./middleware/securityHeaders";
import { publicLimiter, adminLimiter } from "./middleware/rateLimit";
import { versionHeaders, acceptVersion, deprecationHeaders } from "./middleware/versioning";
import { runWithCorrelationId, generateCorrelationId } from "./lib/correlation";
import { logger } from "./lib/logger";
import { getTraces, getTraceSummary } from "./lib/tracer";
import { tracingMiddleware } from "./middleware/tracing";
import { checkScheduledRotations } from "./lib/apiKeys";
import { ipWhitelist } from "./middleware/ipWhitelist";
import { requestSigning } from "./middleware/requestSigning";
import { initApm } from "./lib/apm";
import { csrfProtection, setCsrfCookie } from "./middleware/csrf";
import { startSecretRotation, stopSecretRotation, getSecretsStatus } from "./lib/secrets";
import { setLogLevel, getLogLevel } from "./lib/logger";
import { getMigrationStatus, runMigrations, rollbackMigration } from "./lib/migrations";
import { featureFlagContext, registerFlagRoutes } from "./middleware/featureFlags";
import { loadFlags, getFlagAnalytics } from "./lib/feature-flags";
import { compressionMiddleware, getCompressionMetrics } from "./middleware/compression";
import { handleListenError } from "./lib/listen-errors";

const env = initEnv();

// Initialize APM in background — errors are logged but don't block startup
initApm().catch((err: Error) => {
  console.error("[startup] APM initialization failed:", err.message);
});

if (!process.env.ADMIN_API_KEY) {
  console.warn(
    "[startup] WARNING: ADMIN_API_KEY is not set. Admin endpoints will return 500 errors.",
  );
}

const app = express();
const PORT = env.PORT;

// Validate CORS origin
function validateCorsOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;

  if (origin === "*") {
    logger.warn("[startup] WARNING: CORS origin is wildcard ('*'), allowing all origins");
    return origin;
  }

  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      logger.warn(`[startup] WARNING: CORS origin has invalid protocol: ${origin}`);
    }
  } catch {
    throw new Error(
      `Invalid FRONTEND_URL format: "${origin}". Must be a valid URL (e.g., http://localhost:3000)`,
    );
  }

  if (origin === "http://localhost:3000" && config.NODE_ENV === "production") {
    logger.warn(
      "[startup] WARNING: CORS origin is localhost default in production. Set FRONTEND_URL properly.",
    );
  }

  return origin;
}

const corsOrigin = validateCorsOrigin(env.FRONTEND_URL);

// Timezone for all cron schedules. Defaults to UTC so behaviour is identical
// across servers regardless of OS locale. Override with e.g. CRON_TIMEZONE=America/New_York.
const CRON_TIMEZONE = config.CRON_TIMEZONE;

app.use(prometheusMiddleware);
app.use(tracingMiddleware);
app.use(securityHeaders);
app.use(permissionsHeaders);
app.use(cors({ origin: corsOrigin }));
app.use(
  compressionMiddleware({
    threshold: parseInt(process.env.COMPRESSION_THRESHOLD ?? "1024", 10),
    level: parseInt(process.env.COMPRESSION_LEVEL ?? "6", 10),
  }),
);
app.use(express.json({ limit: env.BODY_SIZE_LIMIT }));
app.use(sanitizeInputs);
app.use(csrfProtection);
app.use(requestLogger);
app.use(featureFlagContext);

// ── Liveness ────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => res.json(await getHealth()));

// ── Prometheus metrics ──────────────────────────────────────────────────────
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// ── Readiness ────────────────────────────────────────────────────────────────
app.get("/ready", (_req, res) => {
  const readiness = getReadiness();
  res.status(readiness.status === "ready" ? 200 : 503).json(readiness);
});

// ── Metrics dashboard ────────────────────────────────────────────────────────
app.get("/v1/metrics", adminLimiter, (_req, res) => {
  res.json(getMetrics());
});

// ── Compression metrics ────────────────────────────────────────────────────
app.get("/v1/admin/compression", ipWhitelist, adminLimiter, (_req, res) => {
  res.json(getCompressionMetrics());
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

// ── Secrets status endpoint ─────────────────────────────────────────────────
app.get("/v1/admin/secrets/status", ipWhitelist, adminLimiter, (_req, res) => {
  res.json(getSecretsStatus());
});

// ── Migration management ──────────────────────────────────────────────────
app.get("/v1/admin/migrations", ipWhitelist, adminLimiter, async (_req, res, next) => {
  try {
    const status = await getMigrationStatus();
    res.json(status);
  } catch (err) {
    next(err);
  }
});

app.post("/v1/admin/migrations/up", ipWhitelist, adminLimiter, async (_req, res, next) => {
  try {
    const result = await runMigrations();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post("/v1/admin/migrations/rollback", ipWhitelist, adminLimiter, async (_req, res, next) => {
  try {
    const result = await rollbackMigration();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Log level management ───────────────────────────────────────────────────
app.get("/v1/admin/logging/level", ipWhitelist, adminLimiter, (_req, res) => {
  res.json({ level: getLogLevel() });
});

app.put("/v1/admin/logging/level", ipWhitelist, adminLimiter, (req, res) => {
  const { level } = req.body as { level?: string };
  if (!level) {
    res.status(400).json({ error: "missing_level", message: "Log level is required" });
    return;
  }
  try {
    setLogLevel(level as any);
    res.json({ level: getLogLevel(), message: "Log level updated successfully" });
  } catch (err: any) {
    res.status(400).json({ error: "invalid_level", message: err.message });
  }
});

// ── Feature flag analytics ───────────────────────────────────────────────
app.get("/v1/admin/feature-flags/analytics", ipWhitelist, adminLimiter, (_req, res) => {
  res.json(getFlagAnalytics());
});

// Register feature flag CRUD routes under /v1/admin
const flagAdminRouter = express.Router();
registerFlagRoutes(flagAdminRouter);
app.use("/v1/admin", ipWhitelist, adminLimiter, flagAdminRouter);

// ── v1 routes (current) ──────────────────────────────────────────────────────
const v1 = express.Router();
v1.use(versionHeaders);
v1.use(acceptVersion);

v1.use("/iot", publicLimiter, iotRouter);
v1.use("/admin", ipWhitelist, adminLimiter, requestSigning, adminRouter);
v1.use("/admin/batch", ipWhitelist, adminLimiter, requestSigning, batchRouter);
v1.use("/projects", publicLimiter, projectsRouter);
v1.use("/projects/:id/history", publicLimiter, historyRouter);
v1.use("/projects/aggregate", publicLimiter, aggregateRouter);
v1.use("/portfolio", publicLimiter, portfolioRouter);
v1.use("/roles", ipWhitelist, adminLimiter, requestSigning, rolesRouter);
v1.use("/webhooks", ipWhitelist, adminLimiter, requestSigning, webhooksRouter);
v1.use("/panels", ipWhitelist, adminLimiter, requestSigning, panelsRouter);
v1.use("/metadata", ipWhitelist, adminLimiter, requestSigning, metadataRouter);
v1.use("/dashboard", publicLimiter, dashboardRouter);
v1.use("/email", ipWhitelist, adminLimiter, requestSigning, emailRouter);
v1.use("/anomaly", publicLimiter, anomalyRouter);
v1.use("/scoring/formulas", ipWhitelist, adminLimiter, requestSigning, scoringFormulasRouter);
v1.use("/chains", ipWhitelist, adminLimiter, requestSigning, chainsRouter);
v1.use("/satellite-sources", ipWhitelist, adminLimiter, requestSigning, satelliteSourcesRouter);
v1.use("/comparison", publicLimiter, comparisonRouter);
v1.use("/benchmarking", publicLimiter, benchmarkingRouter);
v1.use("/financial", publicLimiter, financialRouter);
v1.use("/forecast", publicLimiter, forecastRouter);
v1.use("/maintenance", publicLimiter, maintenanceRouter);
v1.use("/investor", publicLimiter, investorRouter);
v1.use("/admin/api-keys", ipWhitelist, adminLimiter, requestSigning, apiKeysRouter);

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
scheduleCron(
  "*/5 * * * *",
  async () => {
    if (isShuttingDown) return;
    try {
      logger.info("[cron] indexing new events");
      await indexer.poll();
      recordCronRun("indexer", "success");
    } catch (err) {
      if (!isErrorRateLimited("cron:indexer")) {
        logger.error("[cron] indexer poll failed", logger.formatError(err));
      }
      recordCronRun("indexer", "error");
    }
  },
  { timezone: CRON_TIMEZONE },
);

// ── Cron: hourly score update ────────────────────────────────────────────────
// Guards against overlapping runs: with many projects and sequential Soroban
// transactions, a run can take longer than the 1-hour schedule interval. Without
// this lock, an overlapping invocation could submit duplicate on-chain updates.
let isScoreUpdateRunning = false;

scheduleCron(
  "0 * * * *",
  async () => {
    if (isShuttingDown) return;
    if (isScoreUpdateRunning) {
      logger.warn("[cron] hourly score update already in progress, skipping this run");
      return;
    }
    isScoreUpdateRunning = true;
    try {
      await runHourlyScoreUpdate();
    } finally {
      isScoreUpdateRunning = false;
    }
  },
  { timezone: CRON_TIMEZONE },
);

// ── Cron: retry queued transactions every 5 minutes ──────────────────────────
scheduleCron(
  "*/5 * * * *",
  async () => {
    if (isShuttingDown) return;
    if (getQueueSize() === 0) return;

    if (!isRpcAvailable()) {
      logger.info(`[cron] tx-queue: RPC unavailable, ${getQueueSize()} transactions pending`);
      return;
    }

    logger.info(`[cron] tx-queue: processing ${getQueueSize()} queued transactions`);
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
        logger.info(
          `[cron] tx-queue: project ${item.projectId} retried successfully tx=${tx_hash}`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        incrementRetry(item.projectId, errMsg);

        if (hasExceededMaxRetries(item.projectId)) {
          logger.error(
            `[cron] tx-queue: project ${item.projectId} exceeded max retries (${maxRetries}), dropping`,
          );
          remove(item.projectId);
        } else {
          logger.warn(
            `[cron] tx-queue: project ${item.projectId} retry failed (attempt ${item.retryCount + 1}), will retry`,
          );
        }
      }
    }

    if (processed.length > 0) {
      logger.info(`[cron] tx-queue: successfully retried ${processed.length} transactions`);
    }
  },
  { timezone: CRON_TIMEZONE },
);

// ── Cron: alert on extended RPC outage (every 5 minutes) ────────────────────
scheduleCron(
  "*/5 * * * *",
  async () => {
    if (isShuttingDown) return;
    if (isRpcOutageExtended(300_000)) {
      const status = getRpcStatus();
      logger.error(
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
scheduleCron(
  "0 * * * *",
  () => {
    if (isShuttingDown) return;
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

// Bind failures (EADDRINUSE, EACCES, …) surface here instead of as an uncaught
// exception with a raw stack trace. Exits 1 so supervisors treat it as a failure.
server.on("error", (err: NodeJS.ErrnoException) => handleListenError(err, PORT));

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

// ── Graceful shutdown (#57) ──────────────────────────────────────────────────
// Track all scheduled cron tasks so we can stop them cleanly.
const cronTasks: ScheduledTask[] = [];

function scheduleCron(
  expression: string,
  fn: () => void | Promise<void>,
  opts?: { timezone?: string },
): void {
  const task = cron.schedule(expression, fn, opts);
  cronTasks.push(task);
}

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const shutdownTimeoutMs = config.SHUTDOWN_TIMEOUT_MS;
  logger.info(`[${signal}] graceful shutdown initiated (timeout: ${shutdownTimeoutMs}ms)`);

  const shutdownPromise = (async () => {
    // 1. Stop accepting new HTTP requests
    logger.info("[shutdown] closing HTTP server (draining in-flight requests)…");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info("[shutdown] HTTP server closed");

    // 2. Stop all cron jobs so no new work starts
    logger.info(`[shutdown] stopping ${cronTasks.length} cron jobs…`);
    for (const task of cronTasks) {
      task.stop();
    }
    logger.info("[shutdown] cron jobs stopped");

    // 3. Drain the RPC connection pool (waits up to 10 s for active connections)
    logger.info("[shutdown] draining RPC connection pool…");
    try {
      await rpcPool.shutdown();
      logger.info("[shutdown] connection pool drained");
    } catch (err: any) {
      logger.error("[shutdown] pool drain error", { error: err?.message });
    }

    logger.info("[shutdown] clean exit");
    process.exit(0);
  })();

  // Apply overall shutdown timeout — force exit if graceful cleanup takes too long
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Shutdown timed out after ${shutdownTimeoutMs}ms`));
    }, shutdownTimeoutMs);
  });

  try {
    await Promise.race([shutdownPromise, timeoutPromise]);
  } catch (err: any) {
    logger.error("[shutdown] forced exit", { error: err?.message });
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;
