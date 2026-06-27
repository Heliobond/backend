export type TaskStatus = "scheduled" | "in_progress" | "completed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";

export interface MaintenanceTask {
  id: string;
  project_id: number;
  title: string;
  description: string;
  action_type: string;
  priority: TaskPriority;
  status: TaskStatus;
  scheduled_date: string;
  completed_date: string | null;
  assigned_to: string;
  estimated_cost: number;
  actual_cost: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface TaskInput {
  project_id?: unknown;
  title?: unknown;
  description?: unknown;
  action_type?: unknown;
  priority?: unknown;
  scheduled_date?: unknown;
  assigned_to?: unknown;
  estimated_cost?: unknown;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  action_type?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  scheduled_date?: string;
  assigned_to?: string;
  estimated_cost?: number;
  actual_cost?: number;
  notes?: string;
}

export interface MaintenanceRecord {
  id: string;
  project_id: number;
  task_id: string | null;
  action_type: string;
  description: string;
  completed_date: string;
  cost: number;
  efficiency_before: number | null;
  efficiency_after: number | null;
  effectiveness_pct: number | null;
  notes: string;
  created_at: string;
}

export interface CalendarEntry {
  date: string;
  tasks: MaintenanceTask[];
}

export interface CompletionStats {
  total: number;
  completed: number;
  cancelled: number;
  in_progress: number;
  scheduled: number;
  completion_rate: number;
  total_estimated_cost: number;
  total_actual_cost: number;
}

export type CalendarView = "daily" | "weekly" | "monthly";

const taskStore = new Map<string, MaintenanceTask>();
const historyStore = new Map<number, MaintenanceRecord[]>();

function generateId(): string {
  return `mt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}

function validateTaskInput(input: TaskInput): Omit<MaintenanceTask, "id" | "status" | "completed_date" | "actual_cost" | "notes" | "created_at" | "updated_at"> {
  const { project_id, title, description, action_type, priority, scheduled_date, assigned_to, estimated_cost } = input;

  if (typeof project_id !== "number" || !Number.isInteger(project_id) || project_id < 1) {
    throw new Error("project_id must be a positive integer");
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("title must be a non-empty string");
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error("description must be a non-empty string");
  }
  if (typeof action_type !== "string" || action_type.trim().length === 0) {
    throw new Error("action_type must be a non-empty string");
  }
  const validPriorities: TaskPriority[] = ["low", "medium", "high", "critical"];
  if (typeof priority !== "string" || !validPriorities.includes(priority as TaskPriority)) {
    throw new Error(`priority must be one of: ${validPriorities.join(", ")}`);
  }
  if (typeof scheduled_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(scheduled_date)) {
    throw new Error("scheduled_date must be a valid date (YYYY-MM-DD)");
  }
  if (typeof assigned_to !== "string" || assigned_to.trim().length === 0) {
    throw new Error("assigned_to must be a non-empty string");
  }
  if (typeof estimated_cost !== "number" || estimated_cost < 0) {
    throw new Error("estimated_cost must be a non-negative number");
  }

  return {
    project_id,
    title: title.trim(),
    description: description.trim(),
    action_type: action_type.trim(),
    priority: priority as TaskPriority,
    scheduled_date,
    assigned_to: assigned_to.trim(),
    estimated_cost,
  };
}

export function createTask(input: TaskInput): MaintenanceTask {
  const validated = validateTaskInput(input);
  const task: MaintenanceTask = {
    id: generateId(),
    ...validated,
    status: "scheduled",
    completed_date: null,
    actual_cost: null,
    notes: "",
    created_at: now(),
    updated_at: now(),
  };
  taskStore.set(task.id, task);
  return task;
}

export function getTask(id: string): MaintenanceTask | undefined {
  return taskStore.get(id);
}

export interface TaskFilter {
  project_id?: number;
  status?: TaskStatus;
  priority?: TaskPriority;
  from_date?: string;
  to_date?: string;
}

export function listTasks(filter?: TaskFilter): MaintenanceTask[] {
  let tasks = Array.from(taskStore.values());

  if (filter) {
    if (filter.project_id !== undefined) {
      tasks = tasks.filter((t) => t.project_id === filter.project_id);
    }
    if (filter.status) {
      tasks = tasks.filter((t) => t.status === filter.status);
    }
    if (filter.priority) {
      tasks = tasks.filter((t) => t.priority === filter.priority);
    }
    if (filter.from_date) {
      tasks = tasks.filter((t) => t.scheduled_date >= filter.from_date!);
    }
    if (filter.to_date) {
      tasks = tasks.filter((t) => t.scheduled_date <= filter.to_date!);
    }
  }

  return tasks.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
}

export function updateTask(id: string, patch: TaskPatch): MaintenanceTask {
  const existing = taskStore.get(id);
  if (!existing) {
    throw new Error("Task not found");
  }

  const updated: MaintenanceTask = {
    ...existing,
    ...patch,
    updated_at: now(),
  };

  if (patch.status === "completed" && !updated.completed_date) {
    updated.completed_date = todayDate();
  }

  taskStore.set(id, updated);
  return updated;
}

export function completeTask(
  id: string,
  actualCost?: number,
  notes?: string,
  effBefore?: number,
  effAfter?: number,
): { task: MaintenanceTask; record: MaintenanceRecord } {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (task.status === "completed") throw new Error("Task is already completed");

  const completedDate = todayDate();
  const updated: MaintenanceTask = {
    ...task,
    status: "completed",
    completed_date: completedDate,
    actual_cost: actualCost ?? task.estimated_cost,
    notes: notes ?? "",
    updated_at: now(),
  };
  taskStore.set(id, updated);

  const effBeforeVal = effBefore ?? null;
  const effAfterVal = effAfter ?? null;
  const effectiveness = (effBeforeVal !== null && effAfterVal !== null && effBeforeVal !== 0)
    ? Math.round(((effAfterVal - effBeforeVal) / effBeforeVal) * 10000) / 100
    : null;

  const record: MaintenanceRecord = {
    id: `mh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    project_id: task.project_id,
    task_id: task.id,
    action_type: task.action_type,
    description: task.description,
    completed_date: completedDate,
    cost: updated.actual_cost ?? 0,
    efficiency_before: effBeforeVal,
    efficiency_after: effAfterVal,
    effectiveness_pct: effectiveness,
    notes: notes ?? "",
    created_at: now(),
  };

  if (!historyStore.has(task.project_id)) {
    historyStore.set(task.project_id, []);
  }
  historyStore.get(task.project_id)!.push(record);

  return { task: updated, record };
}

export function deleteTask(id: string): boolean {
  return taskStore.delete(id);
}

export function getCompletionStats(filter?: TaskFilter): CompletionStats {
  const tasks = listTasks(filter);
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const cancelled = tasks.filter((t) => t.status === "cancelled").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const scheduled = tasks.filter((t) => t.status === "scheduled").length;

  return {
    total,
    completed,
    cancelled,
    in_progress: inProgress,
    scheduled,
    completion_rate: total > 0 ? Math.round((completed / total) * 10000) / 100 : 0,
    total_estimated_cost: tasks.reduce((s, t) => s + t.estimated_cost, 0),
    total_actual_cost: tasks.reduce((s, t) => s + (t.actual_cost ?? 0), 0),
  };
}

export function getCalendar(
  fromDate?: string,
  toDate?: string,
  projectId?: number,
): CalendarEntry[] {
  const tasks = listTasks({ project_id: projectId, from_date: fromDate, to_date: toDate });
  const grouped = new Map<string, MaintenanceTask[]>();

  for (const task of tasks) {
    const date = task.scheduled_date;
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date)!.push(task);
  }

  return Array.from(grouped.entries())
    .map(([date, tasks]) => ({ date, tasks }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function getCalendarView(
  view: CalendarView = "monthly",
  referenceDate?: string,
  projectId?: number,
): CalendarEntry[] {
  const ref = referenceDate ? new Date(referenceDate) : new Date();
  let from: Date;
  let to: Date;

  if (view === "daily") {
    from = new Date(ref);
    to = new Date(ref);
  } else if (view === "weekly") {
    const dayOfWeek = ref.getDay();
    from = new Date(ref);
    from.setDate(ref.getDate() - dayOfWeek);
    to = new Date(from);
    to.setDate(from.getDate() + 6);
  } else {
    from = new Date(ref.getFullYear(), ref.getMonth(), 1);
    to = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  }

  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return getCalendar(fmt(from), fmt(to), projectId);
}

export function recordManualMaintenance(
  projectId: number,
  actionType: string,
  description: string,
  cost: number,
  efficiencyBefore?: number,
  efficiencyAfter?: number,
  notes?: string,
): MaintenanceRecord {
  const effectiveness = (efficiencyBefore !== undefined && efficiencyAfter !== undefined && efficiencyBefore !== 0)
    ? Math.round(((efficiencyAfter - efficiencyBefore) / efficiencyBefore) * 10000) / 100
    : null;

  const record: MaintenanceRecord = {
    id: `mh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    project_id: projectId,
    task_id: null,
    action_type: actionType,
    description,
    completed_date: todayDate(),
    cost,
    efficiency_before: efficiencyBefore ?? null,
    efficiency_after: efficiencyAfter ?? null,
    effectiveness_pct: effectiveness,
    notes: notes ?? "",
    created_at: now(),
  };

  if (!historyStore.has(projectId)) {
    historyStore.set(projectId, []);
  }
  historyStore.get(projectId)!.push(record);

  return record;
}

export function getMaintenanceHistory(projectId: number): MaintenanceRecord[] {
  return historyStore.get(projectId) ?? [];
}

export function listAllHistory(): MaintenanceRecord[] {
  const all: MaintenanceRecord[] = [];
  for (const records of historyStore.values()) {
    all.push(...records);
  }
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function clearAllData(): void {
  taskStore.clear();
  historyStore.clear();
}

export function tasksToCsv(tasks: MaintenanceTask[]): string {
  const header = "id,project_id,title,action_type,priority,status,scheduled_date,completed_date,assigned_to,estimated_cost,actual_cost,notes";
  const rows = tasks.map((t) =>
    `${t.id},${t.project_id},"${t.title}",${t.action_type},${t.priority},${t.status},${t.scheduled_date},${t.completed_date ?? ""},${t.assigned_to},${t.estimated_cost},${t.actual_cost ?? ""},"${t.notes}"`,
  );
  return [header, ...rows].join("\n") + "\n";
}

export function historyToCsv(records: MaintenanceRecord[]): string {
  const header = "id,project_id,task_id,action_type,description,completed_date,cost,efficiency_before,efficiency_after,effectiveness_pct,notes";
  const rows = records.map((r) =>
    `${r.id},${r.project_id},${r.task_id ?? ""},${r.action_type},"${r.description}",${r.completed_date},${r.cost},${r.efficiency_before ?? ""},${r.efficiency_after ?? ""},${r.effectiveness_pct ?? ""},"${r.notes}"`,
  );
  return [header, ...rows].join("\n") + "\n";
}
