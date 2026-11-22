import type { Knex } from "knex";
import fs from "fs";

// In production the TypeScript source tree is absent; migrations live in
// dist/db/migrations as compiled .js files. Use __dirname (which resolves to
// the directory of this compiled file) so both paths work without forking the
// config (#1064).
const isCompiledRuntime = __filename.endsWith(".js");
const migrationsDir = isCompiledRuntime
  ? `${__dirname}/db/migrations`
  : `${__dirname}/../src/db/migrations`;

const baseConfig: Knex.Config = {
  client: "pg",
  migrations: {
    directory: migrationsDir,
    // Use the same extension as the runtime — .js in dist, .ts in src. This
    // gives each migration a stable logical identity regardless of the path, so
    // a database migrated through the development path sees no duplicate
    // migrations after deployment.
    loadExtensions: [isCompiledRuntime ? ".js" : ".ts"],
    tableName: "knex_migrations",
  },
  pool: {
    min: 2,
    max: 10,
    acquireTimeoutMillis: Number(process.env.DB_ACQUIRE_TIMEOUT_MS) || 30000,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 60000,
  },
};

/**
 * TLS options for non-local database connections. Certificate validation is
 * always on; a private CA is supported via DB_SSL_CA_PATH (or DB_SSL_CA /
 * DATABASE_CA).
 */
export function getSslConfig(): { rejectUnauthorized: true; ca?: string } {
  const caPath = process.env.DB_SSL_CA_PATH || process.env.DB_SSL_CA || process.env.DATABASE_CA;
  if (caPath) {
    try {
      return {
        ca: fs.readFileSync(caPath, "utf8"),
        rejectUnauthorized: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read SSL CA file at ${caPath}: ${message}`, { cause: error });
    }
  }
  return { rejectUnauthorized: true };
}

const config: Record<string, Knex.Config> = {
  development: {
    ...baseConfig,
    connection: {
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || "heliobond_dev",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "",
    },
  },

  test: {
    ...baseConfig,
    connection: {
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || "heliobond_test",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "",
    },
    pool: {
      min: 1,
      max: 5,
    },
  },

  staging: {
    ...baseConfig,
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: getSslConfig(),
    },
  },

  production: {
    ...baseConfig,
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: getSslConfig(),
    },
    pool: {
      min: Number(process.env.DB_POOL_MIN) || 5,
      max: Number(process.env.DB_POOL_MAX) || 30,
    },
  },
};

export default config;
