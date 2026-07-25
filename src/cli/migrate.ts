#!/usr/bin/env node
/**
 * CLI runner for database migrations.
 *
 * Usage:
 *   npx ts-node src/cli/migrate.ts up        — run pending migrations
 *   npx ts-node src/cli/migrate.ts down      — rollback last batch
 *   npx ts-node src/cli/migrate.ts down:all  — rollback all migrations
 *   npx ts-node src/cli/migrate.ts status    — show migration status
 *   npx ts-node src/cli/migrate.ts make <name> — create a new migration file
 *   npx ts-node src/cli/migrate.ts validate  — check for missing migration files
 */

import {
  runMigrations,
  rollbackMigration,
  rollbackAll,
  getMigrationStatus,
  makeMigration,
  validateMigrations,
  closeKnexInstance,
} from "../lib/migrations";

const command = process.argv[2];
const arg = process.argv[3];

async function main(): Promise<void> {
  try {
    switch (command) {
      case "up": {
        console.log("Running pending migrations...");
        const result = await runMigrations();
        if (result.completed.length === 0) {
          console.log("Already up to date.");
        } else {
          console.log(`Applied ${result.completed.length} migration(s):`);
          for (const m of result.completed) {
            console.log(`  ✓ ${m}`);
          }
        }
        break;
      }

      case "down": {
        console.log("Rolling back last migration batch...");
        const result = await rollbackMigration();
        if (result.completed.length === 0) {
          console.log("Nothing to rollback.");
        } else {
          console.log(`Rolled back ${result.completed.length} migration(s):`);
          for (const m of result.completed) {
            console.log(`  ✗ ${m}`);
          }
        }
        break;
      }

      case "down:all": {
        console.log("Rolling back all migrations...");
        const result = await rollbackAll();
        if (result.completed.length === 0) {
          console.log("Nothing to rollback.");
        } else {
          console.log(`Rolled back ${result.completed.length} migration(s):`);
          for (const m of result.completed) {
            console.log(`  ✗ ${m}`);
          }
        }
        break;
      }

      case "status": {
        const status = await getMigrationStatus();
        console.log("\nApplied migrations:");
        if (status.current.length === 0) {
          console.log("  (none)");
        } else {
          for (const m of status.current) {
            console.log(`  ✓ [batch ${m.batch}] ${m.migration_name} (${m.applied_at})`);
          }
        }
        console.log("\nPending migrations:");
        if (status.pending.length === 0) {
          console.log("  (none — up to date)");
        } else {
          for (const m of status.pending) {
            console.log(`  ○ ${m}`);
          }
        }
        break;
      }

      case "make": {
        if (!arg) {
          console.error("Usage: migrate make <migration-name>");
          process.exit(1);
        }
        const filename = await makeMigration(arg);
        console.log(`Created: ${filename}`);
        break;
      }

      case "validate": {
        const result = await validateMigrations();
        if (result.valid) {
          console.log("All migration files present.");
        } else {
          console.error("Missing migration files:");
          for (const m of result.missing) {
            console.error(`  ✗ ${m}`);
          }
          process.exit(1);
        }
        break;
      }

      default:
        console.error("Usage: migrate <up|down|down:all|status|make|validate> [name]");
        process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
