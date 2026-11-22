import { spawn, spawnSync } from "child_process";
import { createServer } from "http";
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
      ["-e", "require('ts-node/register'); require('./src/config').validateRequiredEnv();"],
    );

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("Missing required environment variable");
  });

  it("exits with code 1 when the port is already in use", async () => {
    const port = 41000 + Math.floor(Math.random() * 1000);

    // spawnSync blocks the event loop, so the server must be confirmed
    // listening and the child spawned asynchronously.
    const firstServer = createServer();
    await new Promise<void>((resolve) => firstServer.listen(port, resolve));

    try {
      const result = await spawnAsyncWithEnv(
        {
          ADMIN_SECRET_KEY: "x",
          PROJECT_REGISTRY_CONTRACT_ID: "x",
          PORT: String(port),
        },
        ["-e", "require('ts-node/register'); require('./src/index')"],
      );
      expect({
        status: result.status,
        out: (result.stderr + result.stdout).slice(-1500),
      }).toMatchObject({
        status: 1,
        out: expect.stringContaining("already in use"),
      });
    } finally {
      firstServer.close();
    }
  }, 45_000);

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
  return spawnSync(process.execPath, ["-r", "ts-node/register", ...args], {
    cwd: repoRoot,
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function spawnAsyncWithEnv(env: Record<string, string>, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["-r", "ts-node/register", ...args], {
      cwd: repoRoot,
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
