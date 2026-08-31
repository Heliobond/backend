import type { Knex } from "knex";
import { config as appConfig } from "./config";

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

function getConnection(env: string): Knex.PgConnectionConfig {
  const isLocal = env === "development" || env === "test";

  if (!isLocal && (!appConfig.DB_HOST || !appConfig.DB_NAME || !appConfig.DB_USER)) {
    throw new Error(
      `DB_HOST, DB_NAME, and DB_USER must be set for ${env} environment`,
    );
  }

  const host = isLocal ? appConfig.DB_HOST || "localhost" : appConfig.DB_HOST!;
  const database = isLocal
    ? appConfig.DB_NAME || (env === "test" ? "heliobond_test" : "heliobond_dev")
    : appConfig.DB_NAME!;
  const user = isLocal ? appConfig.DB_USER || "postgres" : appConfig.DB_USER!
  const password = appConfig.DB_PASSWORD || "";

  const connection: Knex.PgConnectionConfig = {
    host,
    port: appConfig.DB_PORT,
    database,
    user,
    password,
  };

  if (!isLocal) {
    connection.ssl = { rejectUnauthorized: false };
  }

  return connection;
}

const config: Record<string, Knex.Config> = {
  development: {
    ...baseConfig,
    connection: getConnection("development"),
  },

  test: {
    ...baseConfig,
    connection: getConnection("test"),
    pool: {
      min: 1,
      max: 5,
    },
  },

  staging: {
    ...baseConfig,
    connection: getConnection("staging"),
  },

  production: {
    ...baseConfig,
    connection: getConnection("production"),
    pool: {
      min: 5,
      max: 30,
    },
  },
};

export default config;
