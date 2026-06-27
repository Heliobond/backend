import { Router, Request, Response, NextFunction } from "express";
import {
  analyzeEfficiencyTrend,
  predictFailure,
  recommendMaintenance,
  generateSchedule,
  generateFullReport,
  recommendationToCsv,
  scheduleToCsv,
} from "../lib/maintenance";
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  completeTask,
  deleteTask,
  getCalendar,
  getCalendarView,
  getMaintenanceHistory,
  recordManualMaintenance,
  getCompletionStats,
  tasksToCsv,
  historyToCsv,
} from "../lib/maintenance-tracking";
import { badRequest, parseProjectId, parseOptionalInt } from "../middleware/errors";

const router = Router();

router.get("/:id/trend", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const historyHours = Math.min(Math.max(parseOptionalInt(req.query.history_hours as string, "history_hours", 720), 24), 8760);
    const result = analyzeEfficiencyTrend(id, historyHours);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/:id/failure-prediction", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const historyHours = Math.min(Math.max(parseOptionalInt(req.query.history_hours as string, "history_hours", 720), 24), 8760);
    const result = predictFailure(id, historyHours);

    const format = req.query.format === "csv" ? "csv" : "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="failure-prediction-${id}.csv"`);
      const header = "project_id,current_efficiency,critical_threshold,estimated_hours_to_threshold,estimated_days_to_threshold,severity,trend_quality,confidence,panel_type";
      const row = `${result.project_id},${result.current_efficiency},${result.critical_threshold},${result.estimated_hours_to_threshold},${result.estimated_days_to_threshold},${result.severity},${result.trend_quality},${result.confidence},${result.panel_type}`;
      res.send([header, row].join("\n") + "\n");
      return;
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/:id/recommendation", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const historyHours = Math.min(Math.max(parseOptionalInt(req.query.history_hours as string, "history_hours", 720), 24), 8760);
    const result = recommendMaintenance(id, historyHours);

    const format = req.query.format === "csv" ? "csv" : "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="maintenance-recommendation-${id}.csv"`);
      res.send(recommendationToCsv(result));
      return;
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/:id/schedule", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const historyHours = Math.min(Math.max(parseOptionalInt(req.query.history_hours as string, "history_hours", 720), 24), 8760);
    const result = generateSchedule(id, historyHours);

    const format = req.query.format === "csv" ? "csv" : "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="maintenance-schedule-${id}.csv"`);
      res.send(scheduleToCsv(result));
      return;
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/:id/full-report", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const historyHours = Math.min(Math.max(parseOptionalInt(req.query.history_hours as string, "history_hours", 720), 24), 8760);
    const result = generateFullReport(id, historyHours);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ── Task / work order management ─────────────────────────────────────────────

router.post("/tasks", (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = createTask(req.body ?? {});
    res.status(201).json(task);
  } catch (error) {
    next(error instanceof Error ? badRequest(error.message) : error);
  }
});

router.get("/tasks", (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.project_id) filter.project_id = Number(req.query.project_id);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.priority) filter.priority = req.query.priority;
    if (req.query.from_date) filter.from_date = req.query.from_date;
    if (req.query.to_date) filter.to_date = req.query.to_date;

    const tasks = listTasks(filter as any);

    const format = req.query.format === "csv" ? "csv" : "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="maintenance-tasks.csv"');
      res.send(tasksToCsv(tasks));
      return;
    }

    res.json({ tasks, count: tasks.length });
  } catch (error) {
    next(error);
  }
});

router.post("/tasks/generate/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const historyHours = Math.min(Math.max(parseOptionalInt(req.query.history_hours as string, "history_hours", 720), 24), 8760);

    const recommendation = recommendMaintenance(id, historyHours);
    const schedule = generateSchedule(id, historyHours);

    const tasks = schedule.schedule.map((entry) => {
      return entry.actions.map((action) =>
        createTask({
          project_id: id,
          title: `${action.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} - Project ${id}`,
          description: action.description,
          action_type: action.type,
          priority: action.priority,
          scheduled_date: entry.date,
          assigned_to: "unassigned",
          estimated_cost: action.estimated_cost,
        }),
      );
    }).flat();

    res.status(201).json({ tasks, count: tasks.length });
  } catch (error) {
    next(error);
  }
});

router.get("/tasks/:taskId", (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = getTask(req.params.taskId as string);
    if (!task) {
      res.status(404).json({ error: "not_found", message: "Task not found" });
      return;
    }
    res.json(task);
  } catch (error) {
    next(error);
  }
});

router.patch("/tasks/:taskId", (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = updateTask(req.params.taskId as string, req.body ?? {});
    res.json(task);
  } catch (error) {
    next(error instanceof Error ? badRequest(error.message) : error);
  }
});

router.post("/tasks/:taskId/complete", (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, unknown>;
    const result = completeTask(
      req.params.taskId as string,
      body.actual_cost as number | undefined,
      body.notes as string | undefined,
      body.efficiency_before as number | undefined,
      body.efficiency_after as number | undefined,
    );
    res.json(result);
  } catch (error) {
    next(error instanceof Error ? badRequest(error.message) : error);
  }
});

router.delete("/tasks/:taskId", (req: Request, res: Response, next: NextFunction) => {
  try {
    const removed = deleteTask(req.params.taskId as string);
    if (!removed) {
      res.status(404).json({ error: "not_found", message: "Task not found" });
      return;
    }
    res.json({ removed: true });
  } catch (error) {
    next(error);
  }
});

// ── Calendar ─────────────────────────────────────────────────────────────────

router.get("/calendar", (req: Request, res: Response, next: NextFunction) => {
  try {
    const view = (req.query.view as string) ?? "monthly";
    const refDate = req.query.date as string | undefined;
    const projectId = req.query.project_id ? Number(req.query.project_id) : undefined;

    if (!["daily", "weekly", "monthly"].includes(view)) {
      throw badRequest('view must be one of: daily, weekly, monthly');
    }

    const entries = getCalendarView(view as any, refDate, projectId);
    res.json({ view, entries, count: entries.reduce((s, e) => s + e.tasks.length, 0) });
  } catch (error) {
    next(error);
  }
});

router.get("/calendar/range", (req: Request, res: Response, next: NextFunction) => {
  try {
    const from = req.query.from as string;
    const to = req.query.to as string;
    const projectId = req.query.project_id ? Number(req.query.project_id) : undefined;

    if (!from || !to) throw badRequest("from and to query parameters are required (YYYY-MM-DD)");

    const entries = getCalendar(from, to, projectId);
    res.json({ from, to, entries, count: entries.reduce((s, e) => s + e.tasks.length, 0) });
  } catch (error) {
    next(error);
  }
});

// ── Maintenance history ──────────────────────────────────────────────────────

router.get("/history/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const records = getMaintenanceHistory(id);

    const format = req.query.format === "csv" ? "csv" : "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="maintenance-history-${id}.csv"`);
      res.send(historyToCsv(records));
      return;
    }

    res.json({ project_id: id, count: records.length, records });
  } catch (error) {
    next(error);
  }
});

router.post("/history/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const body = req.body as Record<string, unknown>;

    if (typeof body.action_type !== "string" || body.action_type.trim().length === 0) throw badRequest("action_type is required");
    if (typeof body.description !== "string" || body.description.trim().length === 0) throw badRequest("description is required");
    if (typeof body.cost !== "number" || body.cost < 0) throw badRequest("cost must be a non-negative number");

    const record = recordManualMaintenance(
      id,
      body.action_type,
      body.description,
      body.cost,
      body.efficiency_before as number | undefined,
      body.efficiency_after as number | undefined,
      body.notes as string | undefined,
    );

    res.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

// ── Completion stats ─────────────────────────────────────────────────────────

router.get("/stats", (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.project_id) filter.project_id = Number(req.query.project_id);

    const stats = getCompletionStats(filter as any);
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

export default router;
