import express from "express";
import cors from "cors";
import cron from "node-cron";
import dotenv from "dotenv";
import iotRouter from "./routes/iot";
import adminRouter from "./routes/admin";
import projectsRouter from "./routes/projects";
import portfolioRouter from "./routes/portfolio";
import { getSolarData, getSatelliteData } from "./routes/iot";
import { computeScores } from "./lib/scoring";
import { updateImpactScore, getTotalProjects } from "./lib/registry";
import { indexer } from "./lib/indexer";

dotenv.config();
const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/iot", iotRouter);
app.use("/api/admin", adminRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/portfolio", portfolioRouter);

// Every 5 minutes: poll for new contract events
cron.schedule("*/5 * * * *", async () => {
  try {
    console.log("[cron] indexing new events");
    await indexer.poll();
  } catch (err) {
    console.error("[cron] indexer poll failed:", err);
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
        console.log(`[cron] project ${projectId}: cq=${scores.credit_quality} gi=${scores.green_impact} tx=${tx_hash}`);
      } catch (err) {
        console.error(`[cron] project ${projectId} failed:`, err);
      }
    }
  } catch (err) {
    console.error("[cron] score update failed:", err);
  }
});

app.listen(PORT, () => {
  console.log(`Heliobond backend listening on port ${PORT}`);
});

export default app;
