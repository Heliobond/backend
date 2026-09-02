export interface Env {
  PORT: number;
  FRONTEND_URL: string;
  REQUEST_TIMEOUT_MS: number;
  ADMIN_REQUEST_TIMEOUT_MS: number;
}

export function initEnv(): Env {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
  const requestTimeoutMs = parseInt(process.env.REQUEST_TIMEOUT_MS ?? "30000", 10);
  const adminRequestTimeoutMs = parseInt(process.env.ADMIN_REQUEST_TIMEOUT_MS ?? "60000", 10);

  return {
    PORT: port,
    FRONTEND_URL: frontendUrl,
    REQUEST_TIMEOUT_MS: requestTimeoutMs,
    ADMIN_REQUEST_TIMEOUT_MS: adminRequestTimeoutMs,
  };
}
