export interface Env {
  PORT: number;
  FRONTEND_URL: string;
}

export function initEnv(): Env {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";

  return {
    PORT: port,
    FRONTEND_URL: frontendUrl,
  };
}
