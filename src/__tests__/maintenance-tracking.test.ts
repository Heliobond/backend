import request from "supertest";
import express, { Express } from "express";
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
  clearAllData,
} from "../lib/maintenance-tracking";
import maintenanceRouter from "../routes/maintenance";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/maintenance", maintenanceRouter);
  app.use(errorHandler);
  return app;
}

const validTask = {
  project_id: 1,
  title: "Panel Cleaning - Project 1",
  description: "Routine cleaning of solar panels to remove dust and debris",
  action_type: "cleaning",
  priority: "medium",
  scheduled_date: "2026-07-15",
  assigned_to: "Field Team A",
  estimated_cost: 800,
};

describe("createTask", () => {
  beforeEach(clearAllData);

  it("creates a task with generated id and default fields", () => {
    const task = createTask(validTask);
    expect(task.id).toMatch(/^mt_/);
    expect(task.project_id).toBe(1);
    expect(task.title).toBe("Panel Cleaning - Project 1");
    expect(task.status).toBe("scheduled");
    expect(task.completed_date).toBeNull();
    expect(task.actual_cost).toBeNull();
    expect(task.notes).toBe("");
    expect(task.created_at).toBeTruthy();
    expect(task.updated_at).toBeTruthy();
  });

  it("rejects invalid input", () => {
    expect(() => createTask({} as any)).toThrow();
    expect(() => createTask({ ...validTask, project_id: "abc" } as any)).toThrow();
    expect(() => createTask({ ...validTask, priority: "urgent" } as any)).toThrow();
    expect(() => createTask({ ...validTask, estimated_cost: -5 } as any)).toThrow();
    expect(() => createTask({ ...validTask, scheduled_date: "invalid" } as any)).toThrow();
    expect(() => createTask({ ...validTask, title: "" } as any)).toThrow();
  });
});

describe("listTasks / getTask", () => {
  beforeEach(clearAllData);

  it("lists all tasks", () => {
    createTask(validTask);
    createTask({ ...validTask, project_id: 2, title: "Inspection - Project 2" });
    const tasks = listTasks();
    expect(tasks).toHaveLength(2);
  });

  it("filters by project_id", () => {
    createTask(validTask);
    createTask({ ...validTask, project_id: 2, title: "Inspection - Project 2" });
    const tasks = listTasks({ project_id: 2 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].project_id).toBe(2);
  });

  it("filters by status", () => {
    const t = createTask(validTask);
    completeTask(t.id, 750);
    createTask({ ...validTask, title: "Inspection" });

    const completed = listTasks({ status: "completed" });
    const scheduled = listTasks({ status: "scheduled" });
    expect(completed).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
  });

  it("filters by date range", () => {
    createTask(validTask);
    createTask({ ...validTask, title: "Inspection", scheduled_date: "2026-08-01" });

    const tasks = listTasks({ from_date: "2026-08-01", to_date: "2026-08-31" });
    expect(tasks).toHaveLength(1);
  });

  it("getTask returns undefined for unknown id", () => {
    expect(getTask("nonexistent")).toBeUndefined();
  });

  it("getTask returns the task", () => {
    const task = createTask(validTask);
    expect(getTask(task.id)).toEqual(task);
  });
});

describe("updateTask", () => {
  beforeEach(clearAllData);

  it("patches task fields", () => {
    const task = createTask(validTask);
    const updated = updateTask(task.id, { title: "Updated Title", priority: "high" });
    expect(updated.title).toBe("Updated Title");
    expect(updated.priority).toBe("high");
    expect(updated.updated_at).toBeTruthy();
  });

  it("throws for unknown task", () => {
    expect(() => updateTask("nonexistent", { title: "x" })).toThrow("Task not found");
  });
});

describe("completeTask", () => {
  beforeEach(clearAllData);

  it("marks task as completed and creates history record", () => {
    const task = createTask(validTask);
    const { task: updated, record } = completeTask(task.id, 750, "Completed on time", 68.5, 72.3);

    expect(updated.status).toBe("completed");
    expect(updated.completed_date).toBeTruthy();
    expect(updated.actual_cost).toBe(750);

    expect(record.task_id).toBe(task.id);
    expect(record.project_id).toBe(1);
    expect(record.efficiency_before).toBe(68.5);
    expect(record.efficiency_after).toBe(72.3);
    expect(record.effectiveness_pct).toBeCloseTo(5.55, 1);
  });

  it("throws for already completed task", () => {
    const task = createTask(validTask);
    completeTask(task.id);
    expect(() => completeTask(task.id)).toThrow("already completed");
  });
});

describe("deleteTask", () => {
  beforeEach(clearAllData);

  it("removes the task", () => {
    const task = createTask(validTask);
    expect(deleteTask(task.id)).toBe(true);
    expect(getTask(task.id)).toBeUndefined();
  });

  it("returns false for unknown id", () => {
    expect(deleteTask("nonexistent")).toBe(false);
  });
});

describe("getCalendar", () => {
  beforeEach(clearAllData);

  it("groups tasks by date", () => {
    createTask(validTask);
    createTask({ ...validTask, title: "Task 2", scheduled_date: "2026-07-15" });
    createTask({ ...validTask, title: "Task 3", scheduled_date: "2026-08-01" });

    const entries = getCalendar("2026-07-01", "2026-08-31");
    expect(entries).toHaveLength(2); // 2 distinct dates
    expect(entries[0].tasks).toHaveLength(2); // July 15 has 2 tasks
    expect(entries[1].tasks).toHaveLength(1); // Aug 1 has 1
  });
});

describe("getCalendarView", () => {
  beforeEach(clearAllData);

  it("returns monthly view", () => {
    createTask({ ...validTask, scheduled_date: "2026-07-10" });
    createTask({ ...validTask, title: "B", scheduled_date: "2026-07-20" });

    const entries = getCalendarView("monthly", "2026-07-01");
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });
});

describe("recordManualMaintenance / getMaintenanceHistory", () => {
  beforeEach(clearAllData);

  it("records a manual maintenance event", () => {
    const record = recordManualMaintenance(1, "repair", "Fixed inverter", 2000, 65, 78);
    expect(record.id).toMatch(/^mh_/);
    expect(record.task_id).toBeNull();
    expect(record.effectiveness_pct).toBe(20);
  });

  it("returns history for a project", () => {
    recordManualMaintenance(1, "cleaning", "Cleaned panels", 500);
    recordManualMaintenance(1, "repair", "Fixed wiring", 1200);
    recordManualMaintenance(2, "inspection", "Routine check", 300);

    const history = getMaintenanceHistory(1);
    expect(history).toHaveLength(2);
    expect(getMaintenanceHistory(2)).toHaveLength(1);
    expect(getMaintenanceHistory(99)).toHaveLength(0);
  });
});

describe("getCompletionStats", () => {
  beforeEach(clearAllData);

  it("returns correct stats", () => {
    const t1 = createTask(validTask);
    const t2 = createTask({ ...validTask, title: "B" });
    createTask({ ...validTask, title: "C" });

    completeTask(t1.id, 500);
    completeTask(t2.id, 600);

    const stats = getCompletionStats();
    expect(stats.total).toBe(3);
    expect(stats.completed).toBe(2);
    expect(stats.scheduled).toBe(1);
    expect(stats.completion_rate).toBeCloseTo(66.67, 1);
  });
});

describe("CSV export", () => {
  beforeEach(clearAllData);

  it("tasksToCsv includes header", () => {
    createTask(validTask);
    const tasks = listTasks();
    const csv = tasksToCsv(tasks);
    expect(csv).toContain("id,project_id,title,action_type,priority,status,scheduled_date");
    expect(csv.split("\n").filter(Boolean)).toHaveLength(2); // header + 1 row
  });

  it("historyToCsv includes records", () => {
    recordManualMaintenance(1, "cleaning", "Cleaned", 500, 70, 75);
    const records = getMaintenanceHistory(1);
    const csv = historyToCsv(records);
    expect(csv).toContain("effectiveness_pct");
    expect(csv).toContain("7.14");
  });
});

describe("maintenance tracking API routes", () => {
  let app: Express;

  beforeEach(() => {
    clearAllData();
    app = buildApp();
  });

  it("POST /api/maintenance/tasks — creates a task", async () => {
    const res = await request(app)
      .post("/api/maintenance/tasks")
      .send(validTask)
      .expect(201);
    expect(res.body.id).toMatch(/^mt_/);
    expect(res.body.status).toBe("scheduled");
    expect(res.body.project_id).toBe(1);
  });

  it("POST /api/maintenance/tasks — rejects invalid input", async () => {
    await request(app)
      .post("/api/maintenance/tasks")
      .send({ project_id: "bad" })
      .expect(400);
  });

  it("GET /api/maintenance/tasks — lists tasks", async () => {
    await request(app).post("/api/maintenance/tasks").send(validTask);
    await request(app).post("/api/maintenance/tasks").send({ ...validTask, title: "Task 2" });

    const res = await request(app)
      .get("/api/maintenance/tasks")
      .expect(200);
    expect(res.body.tasks).toHaveLength(2);
    expect(res.body.count).toBe(2);
  });

  it("GET /api/maintenance/tasks — filters by status", async () => {
    const create = await request(app).post("/api/maintenance/tasks").send(validTask);
    await request(app).post(`/api/maintenance/tasks/${create.body.id}/complete`).send({});

    const res = await request(app)
      .get("/api/maintenance/tasks?status=completed")
      .expect(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].status).toBe("completed");
  });

  it("GET /api/maintenance/tasks?format=csv — returns CSV", async () => {
    await request(app).post("/api/maintenance/tasks").send(validTask);
    const res = await request(app)
      .get("/api/maintenance/tasks?format=csv")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("action_type,priority");
  });

  it("POST /api/maintenance/tasks/generate/:id — generates tasks from recommendation", async () => {
    const res = await request(app)
      .post("/api/maintenance/tasks/generate/1")
      .expect(201);
    expect(res.body.tasks).toBeInstanceOf(Array);
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.tasks[0].id).toMatch(/^mt_/);
  });

  it("GET /api/maintenance/tasks/:taskId — returns a single task", async () => {
    const create = await request(app).post("/api/maintenance/tasks").send(validTask);
    const res = await request(app)
      .get(`/api/maintenance/tasks/${create.body.id}`)
      .expect(200);
    expect(res.body.title).toBe("Panel Cleaning - Project 1");
  });

  it("GET /api/maintenance/tasks/:taskId — 404 for unknown id", async () => {
    await request(app)
      .get("/api/maintenance/tasks/nonexistent")
      .expect(404);
  });

  it("PATCH /api/maintenance/tasks/:taskId — updates a task", async () => {
    const create = await request(app).post("/api/maintenance/tasks").send(validTask);
    const res = await request(app)
      .patch(`/api/maintenance/tasks/${create.body.id}`)
      .send({ priority: "high", assigned_to: "Team B" })
      .expect(200);
    expect(res.body.priority).toBe("high");
    expect(res.body.assigned_to).toBe("Team B");
  });

  it("POST /api/maintenance/tasks/:taskId/complete — completes a task", async () => {
    const create = await request(app).post("/api/maintenance/tasks").send(validTask);
    const res = await request(app)
      .post(`/api/maintenance/tasks/${create.body.id}/complete`)
      .send({ actual_cost: 750, notes: "Done", efficiency_before: 70, efficiency_after: 75 })
      .expect(200);
    expect(res.body.task.status).toBe("completed");
    expect(res.body.record).toBeDefined();
    expect(res.body.record.effectiveness_pct).toBeCloseTo(7.14, 1);
  });

  it("DELETE /api/maintenance/tasks/:taskId — removes a task", async () => {
    const create = await request(app).post("/api/maintenance/tasks").send(validTask);
    await request(app)
      .delete(`/api/maintenance/tasks/${create.body.id}`)
      .expect(200)
      .expect({ removed: true });
  });

  it("DELETE /api/maintenance/tasks/:taskId — 404 for unknown", async () => {
    await request(app)
      .delete("/api/maintenance/tasks/nonexistent")
      .expect(404);
  });

  it("GET /api/maintenance/calendar — returns calendar entries", async () => {
    await request(app).post("/api/maintenance/tasks").send(validTask);
    await request(app).post("/api/maintenance/tasks").send({ ...validTask, title: "B", scheduled_date: "2026-07-20" });

    const res = await request(app)
      .get("/api/maintenance/calendar?view=monthly&date=2026-07-01")
      .expect(200);
    expect(res.body.view).toBe("monthly");
    expect(res.body.entries).toBeInstanceOf(Array);
    expect(res.body.count).toBe(2);
  });

  it("GET /api/maintenance/calendar — rejects invalid view", async () => {
    await request(app)
      .get("/api/maintenance/calendar?view=yearly")
      .expect(400);
  });

  it("GET /api/maintenance/calendar/range — returns tasks in date range", async () => {
    await request(app).post("/api/maintenance/tasks").send(validTask);
    const res = await request(app)
      .get("/api/maintenance/calendar/range?from=2026-07-01&to=2026-07-31")
      .expect(200);
    expect(res.body.entries).toBeInstanceOf(Array);
    expect(res.body.from).toBe("2026-07-01");
  });

  it("GET /api/maintenance/calendar/range — 400 without params", async () => {
    await request(app)
      .get("/api/maintenance/calendar/range")
      .expect(400);
  });

  it("GET /api/maintenance/history/:id — returns maintenance history", async () => {
    const res = await request(app)
      .get("/api/maintenance/history/1")
      .expect(200);
    expect(res.body.project_id).toBe(1);
    expect(res.body.records).toBeInstanceOf(Array);
  });

  it("GET /api/maintenance/history/:id?format=csv — returns CSV", async () => {
    const res = await request(app)
      .get("/api/maintenance/history/1?format=csv")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("effectiveness_pct");
  });

  it("POST /api/maintenance/history/:id — records manual maintenance", async () => {
    const res = await request(app)
      .post("/api/maintenance/history/1")
      .send({ action_type: "repair", description: "Fixed inverter", cost: 2000, efficiency_before: 65, efficiency_after: 80 })
      .expect(201);
    expect(res.body.id).toMatch(/^mh_/);
    expect(res.body.effectiveness_pct).toBeCloseTo(23.08, 1);
  });

  it("POST /api/maintenance/history/:id — rejects missing fields", async () => {
    await request(app)
      .post("/api/maintenance/history/1")
      .send({ cost: 500 })
      .expect(400);
  });

  it("GET /api/maintenance/stats — returns completion stats", async () => {
    const create = await request(app).post("/api/maintenance/tasks").send(validTask);
    await request(app).post(`/api/maintenance/tasks/${create.body.id}/complete`).send({});

    const res = await request(app)
      .get("/api/maintenance/stats")
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.completed).toBe(1);
    expect(res.body.completion_rate).toBe(100);
  });
});
