import { Router, Request, Response, NextFunction } from "express";
import {
  forecastProject,
  forecastWeatherAdjusted,
  analyzeSeasonalPatterns,
  evaluateForecastAccuracy,
  forecastToCsv,
  seasonalPatternsToCsv,
  accuracyToCsv,
  getValidMethods,
  isMethodValid,
} from "../lib/forecast";
import { badRequest, parseProjectId, parseOptionalInt } from "../middleware/errors";

const router = Router();

function parseOptionalFloat(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
}

function parseForecastField(raw: string | undefined): "power_output_kw" | "efficiency_pct" {
  if (raw === "efficiency_pct") return "efficiency_pct";
  return "power_output_kw";
}

router.get("/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const horizon = Math.min(Math.max(parseOptionalInt(req.query.horizon as string, "horizon", 24), 1), 8760);
    const field = parseForecastField(req.query.field as string | undefined);
    const method = (req.query.method as string) ?? "exponential_smoothing";
    const historyHours = Math.min(Math.max(parseOptionalInt(req.query.history_hours as string, "history_hours", 168), 4), 8760);

    if (!isMethodValid(method)) {
      throw badRequest(`Invalid method "${method}". Valid methods: ${getValidMethods().join(", ")}`);
    }

    const result = forecastProject(id, field, horizon, method, historyHours);

    const format = req.query.format === "csv" ? "csv" : "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="forecast-${id}.csv"`);
      res.send(forecastToCsv(result));
      return;
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/weather-adjusted/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const horizon = Math.min(Math.max(parseOptionalInt(req.query.horizon as string, "horizon", 24), 1), 8760);
    const historyHours = Math.min(Math.max(parseOptionalInt(req.query.history_hours as string, "history_hours", 168), 4), 8760);

    const result = forecastWeatherAdjusted(id, horizon, historyHours);

    const format = req.query.format === "csv" ? "csv" : "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="forecast-weather-adjusted-${id}.csv"`);
      res.send(forecastToCsv(result));
      return;
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/seasonal/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const field = parseForecastField(req.query.field as string | undefined);
    const historyHours = Math.min(Math.max(parseOptionalInt(req.query.history_hours as string, "history_hours", 720), 24), 8760);

    const result = analyzeSeasonalPatterns(id, field, historyHours);

    const format = req.query.format === "csv" ? "csv" : "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="seasonal-patterns-${id}.csv"`);
      res.send(seasonalPatternsToCsv(id, result));
      return;
    }

    res.json({ project_id: id, field, ...result });
  } catch (error) {
    next(error);
  }
});

router.get("/accuracy/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const field = parseForecastField(req.query.field as string | undefined);
    const method = (req.query.method as string) ?? "exponential_smoothing";
    const testHours = Math.min(Math.max(parseOptionalInt(req.query.test_hours as string, "test_hours", 24), 1), 8760);
    const trainingHours = Math.min(Math.max(parseOptionalInt(req.query.training_hours as string, "training_hours", 168), 4), 8760);

    if (!isMethodValid(method)) {
      throw badRequest(`Invalid method "${method}". Valid methods: ${getValidMethods().join(", ")}`);
    }

    const result = evaluateForecastAccuracy(id, field, method, testHours, trainingHours);

    const format = req.query.format === "csv" ? "csv" : "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="forecast-accuracy-${id}.csv"`);
      res.send(accuracyToCsv(result));
      return;
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/methods/available", (_req: Request, res: Response) => {
  res.json({ methods: getValidMethods() });
});

export default router;
