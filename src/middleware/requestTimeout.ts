import { Request, Response, NextFunction } from "express";
import { errorBody } from "./errors";

const DEFAULT_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10);
const ADMIN_TIMEOUT_MS = parseInt(process.env.ADMIN_REQUEST_TIMEOUT_MS || "60000", 10);

export interface RequestTimeoutOptions {
  /** Timeout in milliseconds. Defaults to REQUEST_TIMEOUT_MS (admin paths use ADMIN_REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Message included in the 408 response body. */
  message?: string;
}

/**
 * Express middleware that enforces a request timeout.
 *
 * The timer is cleared when the response finishes *or* when the client closes
 * the connection early. In the latter case (and on timeout) an AbortSignal is
 * aborted and exposed as `res.locals.abortSignal` (the controller is also on
 * `res.locals.abortController`) so work that supports cancellation can stop
 * instead of continuing against a dead response.
 */
export function createRequestTimeout(
  options: RequestTimeoutOptions | number = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const opts = typeof options === "number" ? { timeoutMs: options } : options;

  return function requestTimeout(req: Request, res: Response, next: NextFunction): void {
    const timeoutMs =
      opts.timeoutMs ?? (req.path.startsWith("/admin") ? ADMIN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const message = opts.message ?? "Request timed out";

    // A broader middleware (e.g. the global timeout and the admin timeout) may
    // have installed a timer already. Supersede it rather than leaking it.
    const existingTimer = res.locals.timeoutTimer as NodeJS.Timeout | undefined;
    if (existingTimer) clearTimeout(existingTimer);

    const controller = new AbortController();
    res.locals.abortSignal = controller.signal;
    res.locals.abortController = controller;

    let completed = false;

    const clearTimer = (): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      clearTimer();
      if (!res.headersSent) {
        res.status(408).json(errorBody("request_timeout", message));
      }
      controller.abort(new Error("request_timeout"));
      req.destroy();
    }, timeoutMs);

    res.locals.timeoutTimer = timer;

    res.once("finish", clearTimer);
    res.once("close", () => {
      const clientDisconnected = !res.writableEnded;
      clearTimer();
      if (clientDisconnected && !controller.signal.aborted) {
        controller.abort(new Error("client_disconnected"));
      }
    });

    next();
  };
}

export default createRequestTimeout;
