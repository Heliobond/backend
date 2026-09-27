import express, { Router } from "express";
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
import { publicLimiter, adminLimiter } from "./middleware/rateLimit";
import { versionHeaders, acceptVersion } from "./middleware/versioning";
import { ipWhitelist } from "./middleware/ipWhitelist";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { requestSigning } from "./middleware/requestSigning";

/**
 * Builds the "current" version router (`/v1`).
 *
 * This is the single source of truth for the v1 route table. It lives apart
 * from `index.ts` because that module starts the HTTP listener, the gRPC
 * server and the cron jobs on import, which makes it impossible to assert the
 * route table in a test. The caller mounts the returned router with
 * `app.use("/v1", createV1Router())`.
 */
export function createV1Router(): Router {
  const v1 = express.Router();
  v1.use(versionHeaders);
  v1.use(acceptVersion);

  v1.use("/iot", publicLimiter, apiKeyAuth, iotRouter);
  v1.use("/admin/batch", ipWhitelist, adminLimiter, requestSigning, batchRouter);
  v1.use("/projects", publicLimiter, apiKeyAuth, projectsRouter);
  v1.use("/projects/:id/history", publicLimiter, apiKeyAuth, historyRouter);
  v1.use("/projects/aggregate", publicLimiter, apiKeyAuth, aggregateRouter);
  v1.use("/portfolio", publicLimiter, portfolioRouter);
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
  v1.use("/forecast", publicLimiter, forecastRouter);
  v1.use("/maintenance", publicLimiter, apiKeyAuth, maintenanceRouter);
  v1.use("/investor", publicLimiter, investorRouter);
  v1.use("/admin/api-keys", ipWhitelist, adminLimiter, requestSigning, apiKeysRouter);

  // `routes/admin.ts` exposes `POST /update-scores` and `GET /audit`, and both
  // are documented under `/v1/admin` (README.md, API.md). The router used to be
  // mounted under the feature-flag analytics prefix, so those documented paths
  // could never resolve (#643).
  //
  // Registered last on purpose: Express runs every `use()` layer whose prefix
  // matches, so a broad `/admin` mount placed *before* `/admin/batch` and
  // `/admin/api-keys` would first push those requests through this router's
  // bearer-token and timestamp middleware and change their auth contract.
  // Keeping it last means only the paths no dedicated mount already claims —
  // i.e. `/update-scores` and `/audit` — fall through to here.
  v1.use("/admin", ipWhitelist, adminLimiter, requestSigning, adminRouter);

  return v1;
}
