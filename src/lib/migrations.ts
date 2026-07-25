import knex, { Knex } from "knex";
import path from "path";
import fs from "fs";
import { logger } from "./logger";
import config from "../knexfile";

let _knex: Knex | null = null;

function getEnvironment(): string {
  return process.env.NODE_ENV || "development";
}

export function getKnexInstance(): Knex {
  if (!_knex) {
    const env = getEnvironment();
    const knexConfig = config[env];
    if (!knexConfig) {
      throw new Error(`No Knex config found for environment: ${env}`);
    }
    _knex = knex(knexConfig);
  }
  return _knex;
}

export async function closeKnexInstance(): Promise<void> {
  if (_knex) {
    await _knex.destroy();
    _knex = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.resolve(__dirname, "../db/migrations");

/**
 * List migration files on disk, sorted by timestamp prefix.
 */
function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
    .sort();
}

/**
 * Get names of migrations already applied in the database.
 */
async function getAppliedMigrations(knexInstance: Knex): Promise<string[]> {
  const hasTable = await knexInstance.schema.hasTable("knex_migrations");
  if (!hasTable) return [];
  const rows = await knexInstance("knex_migrations").select("name").orderBy("id", "asc");
  return rows.map((r: any) => r.name);
}

/**
 * Compute which migration files have not yet been applied.
 */
async function getPendingMigrations(knexInstance: Knex): Promise<string[]> {
  const applied = await getAppliedMigrations(knexInstance);
  const appliedSet = new Set(applied);
  return listMigrationFiles().filter((f) => !appliedSet.has(f));
}

// ── Migration operations ────────────────────────────────────────────────────

export interface MigrationStatus {
  batch: number;
  migration_name: string;
  applied_at: string;
}

export interface MigrationResult {
  success: boolean;
  completed: string[];
  pending: string[];
  errors: string[];
}

/**
 * Run all pending migrations.
 */
export async function runMigrations(): Promise<MigrationResult> {
  const knex = getKnexInstance();
  const result: MigrationResult = { success: true, completed: [], pending: [], errors: [] };

  try {
    // Ensure migration table exists
    const hasTable = await knex.schema.hasTable("knex_migrations");
    if (!hasTable) {
      logger.info("[migrations] creating knex_migrations table");
    }

    // Get pending migrations before running
    result.pending = await getPendingMigrations(knex);

    // Run migrations
    const [batchNo, migrations] = await knex.migrate.latest();

    result.completed = migrations;
    logger.info("[migrations] completed", {
      batch: batchNo,
      count: migrations.length,
      migrations,
    });

    if (migrations.length === 0) {
      logger.info("[migrations] already up to date");
    }
  } catch (err: any) {
    result.success = false;
    result.errors.push(err.message);
    logger.error("[migrations] failed", { error: err.message });
    throw err;
  }

  return result;
}

/**
 * Rollback the last batch of migrations.
 */
export async function rollbackMigration(): Promise<MigrationResult> {
  const knex = getKnexInstance();
  const result: MigrationResult = { success: true, completed: [], pending: [], errors: [] };

  try {
    const [batchNo, migrations] = await knex.migrate.rollback();

    result.completed = migrations;
    logger.info("[migrations] rolled back", {
      batch: batchNo,
      count: migrations.length,
      migrations,
    });

    if (migrations.length === 0) {
      logger.info("[migrations] nothing to rollback");
    }
  } catch (err: any) {
    result.success = false;
    result.errors.push(err.message);
    logger.error("[migrations] rollback failed", { error: err.message });
    throw err;
  }

  return result;
}

/**
 * Rollback all migrations.
 */
export async function rollbackAll(): Promise<MigrationResult> {
  const knex = getKnexInstance();
  const result: MigrationResult = { success: true, completed: [], pending: [], errors: [] };

  try {
    let rolledBack = true;
    while (rolledBack) {
      const [batchNo, migrations] = await knex.migrate.rollback();
      if (migrations.length === 0) {
        rolledBack = false;
      } else {
        result.completed.push(...migrations);
        logger.info("[migrations] rolled back batch", { batch: batchNo, migrations });
      }
    }
  } catch (err: any) {
    result.success = false;
    result.errors.push(err.message);
    logger.error("[migrations] full rollback failed", { error: err.message });
    throw err;
  }

  return result;
}

/**
 * Get current migration status.
 */
export async function getMigrationStatus(): Promise<{
  current: MigrationStatus[];
  pending: string[];
}> {
  const knex = getKnexInstance();
  const hasTable = await knex.schema.hasTable("knex_migrations");

  let current: MigrationStatus[] = [];
  if (hasTable) {
    current = await knex("knex_migrations")
      .select("batch", "name as migration_name", "migrated_at as applied_at")
      .orderBy("id", "asc");
  }

  const pending = await getPendingMigrations(knex);

  return { current, pending };
}

/**
 * Create a new migration file with the given name.
 */
export async function makeMigration(name: string): Promise<string> {
  const knex = getKnexInstance();
  const filename = await knex.migrate.make(name, {
    directory: path.resolve(__dirname, "../db/migrations"),
    extension: "ts",
  });
  logger.info("[migrations] created", { filename });
  return filename;
}

/**
 * Validate that all applied migrations still exist on disk.
 * Returns any missing migration files.
 */
export async function validateMigrations(): Promise<{ valid: boolean; missing: string[] }> {
  const knex = getKnexInstance();
  const appliedNames = await getAppliedMigrations(knex);
  const filesOnDisk = new Set(listMigrationFiles());

  const missing: string[] = [];
  for (const name of appliedNames) {
    if (!filesOnDisk.has(name)) {
      missing.push(name);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Generate a migration status report for health checks.
 */
export async function getMigrationHealth(): Promise<{
  status: "healthy" | "degraded" | "unhealthy";
  applied_count: number;
  pending_count: number;
  last_migration: string | null;
  missing_files: string[];
}> {
  const fallback = {
    status: "healthy" as const,
    applied_count: 0,
    pending_count: 0,
    last_migration: null,
    missing_files: [],
  };

  const check = async () => {
    const knex = getKnexInstance();
    const appliedNames = await getAppliedMigrations(knex);
    const pendingNames = await getPendingMigrations(knex);
    const validation = await validateMigrations();

    const status: "healthy" | "degraded" | "unhealthy" =
      validation.missing.length > 0
        ? "unhealthy"
        : pendingNames.length > 0
          ? "degraded"
          : "healthy";

    return {
      status,
      applied_count: appliedNames.length,
      pending_count: pendingNames.length,
      last_migration: appliedNames[appliedNames.length - 1] ?? null,
      missing_files: validation.missing,
    };
  };

  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Migration health check timeout")), 1000);
      if (typeof timer.unref === "function") timer.unref();
    });
    return await Promise.race([check(), timeout]);
  } catch (err: any) {
    return fallback;
  }
}
