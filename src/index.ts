import express from "express";
import cors from "cors";
import cron, { ScheduledTask } from "node-cron";
import * as grpc from "@grpc/grpc-js";
import { config, initEnv } from "./config";
import { getTotalProjects } from "./lib/registry";
import swaggerUi from "swagger-ui-express";
import iotRouter from "./routes/iot";
import adminRouter from "./routes/admin";
import projectsRouter from "./routes/projects";
import portfolioRouter from "./routes/portfolio";
import rolesRouter from "./routes/roles";
import batchRouter from "./routes/batch";
import webhooksRouter from "./routes/webhooks";
import historyRouter from "./routes/history";
import priceHistoryRouter from "./routes/priceHistory";
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
import investorActivityRouter from "./routes/investorActivity";
import apiKeysRouter from "./routes/apiKeys";
import notificationsRouter, { publicNotificationsRouter } from "./routes/notifications";
import { creatorApplicationsRouter, creatorAdminRouter } from "./routes/creatorApplications";
import oracleStatusRouter from "./routes/oracle-status";
import { createHandler } from "graphql-http/lib/use/express";
import { graphqlSchema, graphqlRoot, createGraphQLContext } from "./graphql/schema";
import { startGrpcServer } from "./grpc/server";
import { assignRole } from "./lib/roles";
import { runHourlyScoreUpdate } from "./lib/scoreUpdateCron";
import { runTxQueueRetry } from "./lib/txQueueRetryCron";
import { isErrorRateLimited } from "./lib/error-limiter";
import { isRpcOutageExtended, getRpcStatus } from "./lib/stellar";
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
import { publicLimiter, adminLimiter, parseTrustProxy } from "./middleware/rateLimit";
import {
  versionHeaders,
  acceptVersion,
  deprecationHeaders,
  legacyApiUsage,
} from "./middleware/versioning";
import { runWithCorrelationId, generateCorrelationId } from "./lib/correlation";
import { logger } from "./lib/logger";
import { getTraces, getTraceSummary } from "./lib/tracer";
import { tracingMiddleware } from "./middleware/tracing";
import { checkScheduledRotations } from "./lib/apiKeys";
import { ipWhitelist } from "./middleware/ipWhitelist";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { requestSigning } from "./middleware/requestSigning";
import { initApm } from "./lib/apm";
import { csrfProtection } from "./middleware/csrf";
import { startSecretRotation, stopSecretRotation, getSecretsStatus } from "./lib/secrets";
import { setLogLevel, getLogLevel } from "./lib/logger";
import { getMigrationStatus, runMigrations, rollbackMigration } from "./lib/migrations";
import { featureFlagContext, registerFlagRoutes } from "./middleware/featureFlags";
import { getFlagAnalytics } from "./lib/feature-flags";
import { compressionMiddleware, getCompressionMetrics } from "./middleware/compression";
import { handleListenError } from "./lib/listen-errors";
import { initBenchmarkSamples } from "./lib/benchmarking";
import { createBenchmarkSampleInitializer } from "./lib/benchmarkStartup";
import { getImpactCertificatePublicKey } from "./lib/impactCertificate";

const env = initEnv();

// ── Process-level error handlers (#694) ──────────────────────────────────────
// These handlers must be registered early (before any async work) to catch
// unhandled promise rejections and uncaught exceptions that would otherwise
// crash the process silently or with only a deprecation warning.
process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  logger.error("[unhandledRejection] Unhandled promise rejection detected", {
    ...logger.formatError(reason),
    promise: String(promise),
  });
  gracefulShutdown("unhandledRejection").catch(() => process.exit(1));
});

process.on("uncaughtException", (err: Error) => {
  logger.error("[uncaughtException] Uncaught exception detected", logger.formatError(err));
  process.exit(1);
});

// Seed initial admin from env var (RBAC bootstrap)
const initialAdminUserId = process.env.INITIAL_ADMIN_USER_ID?.trim();
if (initialAdminUserId) {
  assignRole(initialAdminUserId, "admin");
}

// Initialize APM in background — errors are logged but don't block startup
initApm().catch((err: Error) => {
  console.error("[startup] APM initialization failed:", err.message);
});

if (!process.env.ADMIN_API_KEY) {
  console.warn(
    "[startup] WARNING: ADMIN_API_KEY is not set. Admin endpoints will return 500 errors.",
  );
}

if (!process.env.REQUEST_SIGNING_SECRET) {
  logger.warn(
    "[startup] WARNING: REQUEST_SIGNING_SECRET is not set. Admin endpoints will not verify request signatures.",
  );
}

const app = express();
const PORT = env.PORT;

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const REQUEST_TIMEOUT_MS = parseTimeoutMs(process.env.REQUEST_TIMEOUT_MS, 30000);
const ADMIN_REQUEST_TIMEOUT_MS = parseTimeoutMs(process.env.ADMIN_REQUEST_TIMEOUT_MS, 60000);

function requestTimeout(timeoutMs: number) {
  return (req: any, res: any, next: any) => {
    if (res.locals.timeoutTimer) {
      clearTimeout(res.locals.timeoutTimer);
    }
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(408).json({ error: "request_timeout", message: "Request timed out" });
      }
      req.destroy();
    }, timeoutMs);
    res.locals.timeoutTimer = timer;
    const clearTimer = () => clearTimeout(timer);
    res.once("finish", clearTimer);
    res.once("close", clearTimer);
    next();
  };
}
// Trust proxy configuration — required for Express to parse X-Forwarded-For
// via req.ip / req.ips.  Without this, ipWhitelist must hand-parse headers,
// which is vulnerable to spoofing.
//
// TRUST_PROXY values:
//  - "false"  (default) — no proxy; req.ip is the direct peer address
//  - "true"            — trust all proxies (single hop)
//  - "loopback"        — trust loopback (127.0.0.1/8, ::1) only
//  - a CIDR or IP      — trust specific proxy IP(s)
//  - a number N         — trust the first N hops in X-Forwarded-For
const trustProxy = process.env.TRUST_PROXY || config.TRUST_PROXY || "false";
app.set("trust proxy", parseTrustProxy(trustProxy));

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
app.use(requestTimeout(REQUEST_TIMEOUT_MS));
app.use("/v1/admin", requestTimeout(ADMIN_REQUEST_TIMEOUT_MS));
app.use("/api/admin", requestTimeout(ADMIN_REQUEST_TIMEOUT_MS));
app.use(express.json({ limit: env.BODY_SIZE_LIMIT }));
app.use(sanitizeInputs);
app.use(csrfProtection);
app.use(requestLogger);
app.use(featureFlagContext);

// ── Liveness ────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => res.json(await getHealth()));

app.get("/.well-known/heliobond-impact-key", (_req, res) => {
  res.json({ algorithm: "Ed25519", public_key: getImpactCertificatePublicKey() });
});

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
// Swagger UI bootstraps with an inline script, which the global CSP blocks.
app.use("/docs", (_req, res, next) => {
  res.removeHeader("Content-Security-Policy");
  next();
});
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
  } catch (err) {
    res
      .status(400)
      .json({ error: "invalid_level", message: err instanceof Error ? err.message : String(err) });
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

v1.use("/iot", publicLimiter, apiKeyAuth, iotRouter);
v1.use("/admin/feature-flags/analytics", ipWhitelist, adminLimiter, requestSigning, adminRouter);
v1.use("/admin/batch", ipWhitelist, adminLimiter, requestSigning, batchRouter);
v1.use("/projects", publicLimiter, apiKeyAuth, projectsRouter);
v1.use("/projects/:id/history", publicLimiter, apiKeyAuth, historyRouter);
v1.use("/projects/:id/price-history", publicLimiter, apiKeyAuth, priceHistoryRouter);
v1.use("/projects/aggregate", publicLimiter, apiKeyAuth, aggregateRouter);
v1.use("/portfolio", publicLimiter, apiKeyAuth, portfolioRouter);
v1.use("/roles", ipWhitelist, adminLimiter, rolesRouter);
v1.use("/webhooks", ipWhitelist, adminLimiter, requestSigning, webhooksRouter);
v1.use("/panels", ipWhitelist, adminLimiter, requestSigning, panelsRouter);
v1.use("/metadata", ipWhitelist, adminLimiter, metadataRouter);
v1.use("/dashboards", publicLimiter, apiKeyAuth, dashboardRouter);
v1.use("/email", ipWhitelist, adminLimiter, requestSigning, emailRouter);
v1.use("/anomaly", publicLimiter, anomalyRouter);
v1.use("/scoring/formulas", ipWhitelist, adminLimiter, requestSigning, scoringFormulasRouter);
v1.use("/chains", publicLimiter, adminLimiter, chainsRouter);
v1.use("/satellite-sources", ipWhitelist, adminLimiter, requestSigning, satelliteSourcesRouter);
v1.use("/comparison", publicLimiter, apiKeyAuth, comparisonRouter);
v1.use("/benchmarking", publicLimiter, apiKeyAuth, benchmarkingRouter);
v1.use("/financial", publicLimiter, apiKeyAuth, financialRouter);
v1.use("/forecast", publicLimiter, apiKeyAuth, forecastRouter);
v1.use("/maintenance", publicLimiter, apiKeyAuth, maintenanceRouter);
v1.use("/investor", publicLimiter, apiKeyAuth, investorRouter);
v1.use("/investors", publicLimiter, investorActivityRouter);
v1.use("/status/oracle", publicLimiter, oracleStatusRouter);
v1.use("/admin/api-keys", ipWhitelist, adminLimiter, requestSigning, apiKeysRouter);
v1.use("/notifications", publicLimiter, publicNotificationsRouter); // email-link targets (confirm/unsubscribe)
v1.use("/notifications", publicLimiter, apiKeyAuth, notificationsRouter);
// Creator onboarding (#771): wallet-authenticated creator routes and
// bearer-authenticated admin review routes.
v1.use("/creators", publicLimiter, creatorApplicationsRouter);
v1.use("/admin/creators", ipWhitelist, adminLimiter, creatorAdminRouter);

// ── Legacy /api paths (deprecated) ──────────────────────────────────────────
// Kept for backward compatibility; will be removed after 2027-01-01.
app.use("/api", legacyApiUsage(), deprecationHeaders, versionHeaders);
app.use("/api/iot", publicLimiter, apiKeyAuth, iotRouter);
app.use("/api/admin", ipWhitelist, adminLimiter, adminRouter);
app.use("/api/admin/batch", ipWhitelist, adminLimiter, batchRouter);
app.use("/api/projects", publicLimiter, apiKeyAuth, projectsRouter);
app.use("/api/projects/:id/history", publicLimiter, apiKeyAuth, historyRouter);
app.use("/api/projects/:id/price-history", publicLimiter, apiKeyAuth, priceHistoryRouter);
app.use("/api/projects/aggregate", publicLimiter, apiKeyAuth, aggregateRouter);
app.use("/api/portfolio", publicLimiter, apiKeyAuth, portfolioRouter);
app.use("/api/roles", ipWhitelist, adminLimiter, rolesRouter);
app.use("/api/webhooks", ipWhitelist, adminLimiter, webhooksRouter);
app.use("/api/panels", ipWhitelist, adminLimiter, panelsRouter);
app.use("/api/metadata", ipWhitelist, adminLimiter, metadataRouter);
app.use("/api/dashboard", publicLimiter, apiKeyAuth, dashboardRouter);
app.use("/api/email", ipWhitelist, adminLimiter, emailRouter);
app.use("/api/comparison", publicLimiter, apiKeyAuth, comparisonRouter);
app.use("/api/benchmarking", publicLimiter, apiKeyAuth, benchmarkingRouter);
app.use("/api/financial", publicLimiter, apiKeyAuth, financialRouter);
app.use("/api/forecast", publicLimiter, apiKeyAuth, forecastRouter);
app.use("/api/maintenance", publicLimiter, apiKeyAuth, maintenanceRouter);
app.use("/api/investor", publicLimiter, apiKeyAuth, investorRouter);
app.use("/api/investors", publicLimiter, apiKeyAuth, investorActivityRouter);
app.use("/api/admin/api-keys", ipWhitelist, adminLimiter, apiKeysRouter);

// JSON 404 for anything unmatched, then the structured error handler.
app.use(notFoundHandler);
app.use(errorHandler);

// ── Cron: index contract events every 5 minutes ──────────────────────────────
// `cronTasks` and `scheduleCron` are declared here (not at the bottom of the
// file) because the first scheduleCron call below pushes into the array — a
// const declared later would still be in its temporal dead zone here.
const cronTasks: ScheduledTask[] = [];

function scheduleCron(
  expression: string,
  fn: () => void | Promise<void>,
  opts?: { timezone?: string },
): void {
  const task = cron.schedule(expression, fn, opts);
  cronTasks.push(task);
}

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
    await runTxQueueRetry();
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
    } catch (err) {
      if (!isErrorRateLimited("cron:api-key-rotation")) {
        logger.error("[cron] API key rotation check failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      recordCronRun("api-key-rotation", "error");
    }
  },
  { timezone: CRON_TIMEZONE },
);

const initializeBenchmarkSamples = createBenchmarkSampleInitializer({
  getTotalProjects,
  seedSamples: initBenchmarkSamples,
  warn: logger.warn,
});

// ── Coordinated server startup (#692) ────────────────────────────────────────
// Start both gRPC and HTTP servers in a coordinated way so that if either fails
// to bind, the other is properly cleaned up. This prevents half-initialized state
// where gRPC is running but HTTP isn't (or vice versa).
let grpcServer: grpc.Server | null = null;

const serverPromise = initializeBenchmarkSamples().then(async (sampleSize) => {
  logger.info("[startup] benchmark samples initialized", { sample_size: sampleSize });

  // First, start HTTP server
  const httpServer = await new Promise<any>((resolve, reject) => {
    const server = app.listen(PORT, () => {
      logger.info(`[startup] HTTP server listening on port ${PORT}`);
      resolve(server);
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      logger.error("[startup] HTTP server bind failed", logger.formatError(err));
      reject(err);
    });
  });

  // Then start gRPC server
  try {
    grpcServer = await new Promise<grpc.Server>((resolve, reject) => {
      const server = startGrpcServer(50051, (err, port) => {
        logger.error("[startup] gRPC server bind failed", {
          ...logger.formatError(err),
          port,
        });
        // Clean up HTTP server if gRPC fails
        httpServer.close(() => {
          logger.info("[startup] HTTP server closed due to gRPC bind failure");
        });
        reject(err);
      });
      // Give gRPC server a moment to bind before considering it successful
      setTimeout(() => resolve(server), 100);
    });
    logger.info("[startup] gRPC server started successfully");
  } catch (err) {
    logger.error("[startup] coordinated startup failed, exiting");
    process.exit(1);
  }

  // Real-time score updates over WebSocket (ws://<host>/ws)
  attachWebSocketServer(httpServer);
  return httpServer;
});

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
  // Generate a nonce for inline script CSP
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nonce = require("crypto").randomBytes(16).toString("hex");

  res.setHeader("Content-Type", "text/html");
  // Override CSP to allow inline script with nonce
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' https://unpkg.com 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; connect-src 'self'`,
  );

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
        <script nonce="${nonce}">
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

// Periodically clear cached secrets so a rotated/compromised upstream
// secret doesn't stay cached indefinitely (gated on SECRETS_ROTATION_ENABLED).
startSecretRotation();

// ── Graceful shutdown (#57) ──────────────────────────────────────────────────
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const shutdownTimeoutMs = config.SHUTDOWN_TIMEOUT_MS;
  logger.info(`[${signal}] graceful shutdown initiated (timeout: ${shutdownTimeoutMs}ms)`);

  const shutdownPromise = (async () => {
    // 1. Stop accepting new HTTP requests
    logger.info("[shutdown] closing HTTP server (draining in-flight requests)…");
    const server = await serverPromise;
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
    } catch (err) {
      logger.error("[shutdown] pool drain error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 4. Stop the secret rotation timer so it doesn't keep the process alive
    // or fire after shutdown begins.
    stopSecretRotation();

    // 5. Gracefully stop the gRPC server, letting in-flight/streaming RPCs
    // (e.g. StreamProjectScores) drain instead of being killed mid-stream.
    if (grpcServer) {
      logger.info("[shutdown] draining gRPC server…");
      await new Promise<void>((resolve) => {
        const forceTimer = setTimeout(() => {
          logger.warn("[shutdown] gRPC drain timed out, forcing shutdown");
          grpcServer!.forceShutdown();
          resolve();
        }, shutdownTimeoutMs);
        grpcServer!.tryShutdown((err) => {
          clearTimeout(forceTimer);
          if (err) {
            logger.error("[shutdown] gRPC shutdown error", { error: err.message });
          } else {
            logger.info("[shutdown] gRPC server stopped");
          }
          resolve();
        });
      });
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
  } catch (err) {
    logger.error("[shutdown] forced exit", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;
