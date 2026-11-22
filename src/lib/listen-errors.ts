import { logger } from "./logger";

/**
 * Human-readable explanation for a `net.Server` "error" event raised while the
 * HTTP server is binding. Node's default behaviour is an uncaught exception with
 * a stack trace like `Error: listen EADDRINUSE: address already in use :::3001`,
 * which buries the actual problem — and the fix — in noise.
 */
export function describeListenError(err: NodeJS.ErrnoException, port: number | string): string {
  switch (err.code) {
    case "EADDRINUSE":
      return `Port ${port} is already in use. Stop the process using it or set PORT to a free port.`;
    case "EACCES":
      return `Port ${port} requires elevated privileges. Use a port above 1023 or run with the required permissions.`;
    case "EADDRNOTAVAIL":
      return `The address for port ${port} is not available on this host.`;
    default:
      return `Failed to bind to port ${port}: ${err.message}`;
  }
}

/**
 * Log a clear message for a server bind failure and terminate with a non-zero
 * status so process managers (Docker, systemd, k8s) see the start-up as failed.
 *
 * `exit` is injectable so the behaviour can be tested without killing the runner.
 */
export function handleListenError(
  err: NodeJS.ErrnoException,
  port: number | string,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  logger.error(`[startup] ${describeListenError(err, port)}`, {
    error_code: err.code ?? "UNKNOWN",
    port,
  });
  exit(1);
}
