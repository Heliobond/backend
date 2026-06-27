import express from "express";
import cors from "cors";
import cron from "node-cron";
import dotenv from "dotenv";
import iotRouter from "./routes/iot";
import adminRouter from "./routes/admin";
import projectsRouter from "./routes/projects";
import portfolioRouter from "./routes/portfolio";
import rolesRouter from "./routes/roles";
import batchRouter from "./routes/batch";
import webhooksRouter from "./routes/webhooks";
import historyRouter from "./routes/history";
import { getSolarData, getSatelliteData } from "./routes/iot";
import { computeScores } from "./lib/scoring";
import { updateImpactScore, getTotalProjects } from "./lib/registry";
import { recordScoreHistory } from "./lib/history";
import { triggerWebhooks } from "./lib/webhooks";
import { indexer } from "./lib/indexer";
import { getHealth, recordCronRun } from "./lib/health";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { publicLimiter, adminLimiter } from "./middleware/rateLimit";

dotenv.config();
const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());
app.use(requestLogger);

// Liveness + basic operational visibility (uptime, last cron run).
app.get("/health", (_req, res) => res.json(getHealth()));

// Rate limiting: stricter limits for privileged admin endpoints.
app.use("/api/iot", publicLimiter, iotRouter);
app.use("/api/admin", adminLimiter, adminRouter);
app.use("/api/admin/batch", adminLimiter, batchRouter);
app.use("/api/projects", publicLimiter, projectsRouter);
app.use("/api/projects/:id/history", publicLimiter, historyRouter);
app.use("/api/portfolio", publicLimiter, portfolioRouter);
app.use("/api/roles", adminLimiter, rolesRouter);
app.use("/api/webhooks", adminLimiter, webhooksRouter);

// JSON 404 for anything unmatched, then the structured error handler.
app.use(notFoundHandler);
app.use(errorHandler);

// Every 5 minutes: poll for new contract events
cron.schedule("*/5 * * * *", async () => {
  try {
    console.log("[cron] indexing new events");
    await indexer.poll();
    recordCronRun("indexer", "success");
  } catch (err) {
    console.error("[cron] indexer poll failed:", err);
    recordCronRun("indexer", "error");
  }
});

// Hourly cron: run score update at the top of every hour
cron.schedule("0 * * * *", async () => {
  try {
    console.log("[cron] running hourly score update");
    const total = await getTotalProjects();
    const projectIds = Array.from({ length: total }, (_, i) => i + 1);

    for (const projectId of projectIds) {
      try {
        const solar = getSolarData(projectId);
        const satellite = getSatelliteData(projectId);
        const scores = computeScores({ solar, satellite });
        const tx_hash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact);
        recordScoreHistory(projectId, scores.credit_quality, scores.green_impact);
        triggerWebhooks({ project_id: projectId, ...scores, tx_hash, timestamp: Date.now() });
        console.log(`[cron] project ${projectId}: cq=${scores.credit_quality} gi=${scores.green_impact} tx=${tx_hash}`);
      } catch (err) {
        console.error(`[cron] project ${projectId} failed:`, err);
      }
    }
    recordCronRun("score-update", "success");
  } catch (err) {
    console.error("[cron] score update failed:", err);
    recordCronRun("score-update", "error");
  }
});

app.listen(PORT, () => {
  console.log(`Heliobond backend listening on port ${PORT}`);
});

export default app;
