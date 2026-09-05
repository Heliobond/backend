import type { Knex } from "knex";
import fs from "fs";

const baseConfig: Knex.Config = {
  client: "pg",
  migrations: {
    directory: "./src/db/migrations",
    extension: "ts",
    tableName: "knex_migrations",
  },
  pool: {
    min: 2,
    max: 10,
    acquireTimeoutMillis: 30000,
    idleTimeoutMillis: 60000,
  },
};

/**
 * TLS options for non-local database connections. Certificate validation is
 * always on; a private CA is supported via DB_SSL_CA_PATH (or DB_SSL_CA /
 * DATABASE_CA).
 */
function getSslConfig(): { rejectUnauthorized: true; ca?: string } {
  const caPath = process.env.DB_SSL_CA_PATH || process.env.DB_SSL_CA || process.env.DATABASE_CA;
  if (caPath) {
    return {
      ca: fs.readFileSync(caPath, "utf8"),
      rejectUnauthorized: true,
    };
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
      min: 5,
      max: 30,
    },
  },
};

export default config;
