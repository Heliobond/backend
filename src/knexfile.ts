import type { Knex } from "knex";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
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
    acquireTimeoutMilis: 30000,
    idleTimeoutMilis: 60000,
  },
};

function getSslConfig(): { rejectUnauthorized: true; ca?: string } {
  const caPath =
    process.env.DB_SSL_CA_PATH || process.env.DB_SSL_CA || process.env.DATABASE_CA;
  if (caPath) {
    return {
      ca: fs.readFileSync(caPath, "utf8"),
      rejectUnauthorized: true,
    };
  }
  return { rejectUnauthorized: true };
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
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: getSslConfig(),
    },
    connection: getConnection("staging"),
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
    connection: getConnection("production"),
    pool: {
      min: 5,
      max: 30,
    },
  },
};

export default config;
