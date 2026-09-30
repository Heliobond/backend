import { Pool } from "pg";
import { config } from "../config";
import { getSslConfig } from "../knexfile";

// Connects lazily, so importing this module never opens a connection.
export const pool = new Pool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: config.DB_POOL_ACQUIRE_TIMEOUT_MS,
  ssl: config.NODE_ENV === "production" || config.NODE_ENV === "staging" ? getSslConfig() : false,
});
