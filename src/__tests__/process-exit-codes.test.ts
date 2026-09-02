import { spawnSync } from "child_process";
import http from "http";
import path from "path";

const repoRoot = path.resolve(__dirname, "../..");

describe("process exit codes", () => {
  it("exits with code 1 when required env vars are missing", () => {
    const result = spawnSyncWithEnv(
      {
        ADMIN_SECRET_KEY: "",
        PROJECT_REGISTRY_CONTRACT_ID: "",
        PORT: "0",
      },
      ["-e", "require('./src/config').validateRequiredEnv();"],
    );

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("Missing required environment variable");
  });

  it("exits with code 1 when the port is already in use", () => {
    const port = 41000 + Math.floor(Math.random() * 1000);

    const firstServer = http.createServer();
    firstServer.listen(port);

    try {
      const result = spawnSyncWithEnv(
        {
          ADMIN_SECRET_KEY: "x",
          PROJECT_REGISTRY_CONTRACT_ID: "x",
          PORT: String(port),
        },
        ["-e", "require('./src/config').validateRequiredEnv();"],
      );
      expect(result.status).toBe(1);
    } finally {
      firstServer.close();
    }
  });

  it("exits with code 0 for graceful shutdown", () => {
    const result = spawnSyncWithEnv(
      {
        ADMIN_SECRET_KEY: "x",
        PROJECT_REGISTRY_CONTRACT_ID: "x",
        PORT: "0",
      },
      [
        "-e",
        "const { EventEmitter } = require('events'); const events = new EventEmitter(); process.once('SIGTERM', () => process.exit(0)); process.kill(process.pid, 'SIGTERM');",
      ],
    );

    expect(result.status).toBe(0);
  });

  it("exits with code 1 for uncaught exceptions", () => {
    const result = spawnSyncWithEnv(
      {
        ADMIN_SECRET_KEY: "x",
        PROJECT_REGISTRY_CONTRACT_ID: "x",
      },
      ["-e", "setImmediate(() => { throw new Error('boom'); });"],
    );

    expect(result.status).toBe(1);
  });
});

function spawnSyncWithEnv(env: Record<string, string>, args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}
