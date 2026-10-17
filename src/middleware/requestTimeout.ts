import { Request, Response, NextFunction } from "express";

declare global {
  namespace Express {
    interface Request {
      abortController?: AbortController;
      signal?: AbortSignal;
    }
  }
}

export function parseTimeout(envVal: string | undefined, fallback: number): number {
  if (!envVal) return fallback;
  const parsed = parseInt(envVal, 10);
  return isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export const DEFAULT_TIMEOUT_MS = 30000;
export const ADMIN_TIMEOUT_MS = 60000;

export interface RequestTimeoutOptions {
  defaultTimeoutMs?: number;
  adminTimeoutMs?: number;
}

export function createRequestTimeout(options?: RequestTimeoutOptions) {
  return function requestTimeoutMiddleware(req: Request, res: Response, next: NextFunction): void {
    const defaultTimeout =
      options?.defaultTimeoutMs ?? parseTimeout(process.env.REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const adminTimeout =
      options?.adminTimeoutMs ?? parseTimeout(process.env.ADMIN_REQUEST_TIMEOUT_MS, ADMIN_TIMEOUT_MS);

    const path = typeof req.path === "string" ? req.path : "";
    const isAdmin =
      path === "/admin" ||
      path.startsWith("/admin/") ||
      path === "/api/admin" ||
      path.startsWith("/api/admin/") ||
      path === "/v1/admin" ||
      path.startsWith("/v1/admin/");
    const timeoutMs = isAdmin ? adminTimeout : defaultTimeout;

    // Attach AbortController and AbortSignal to req for downstream handler cancellation
    const controller = new AbortController();
    req.abortController = controller;
    try {
      Object.defineProperty(req, "signal", {
        value: controller.signal,
        writable: true,
        configurable: true,
      });
    } catch {
      (req as { signal?: AbortSignal }).signal = controller.signal;
    }

    let timer: NodeJS.Timeout | null = null;
    let isCleanedUp = false;

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      res.removeListener("finish", onFinish);
      res.removeListener("close", onClose);
      req.removeListener("close", onClose);
      req.removeListener("error", onClose);
    };

    const onFinish = () => {
      cleanup();
    };

    const onClose = () => {
      cleanup();
      // If client disconnected before response was completed, abort downstream work
      if (!res.writableEnded && !controller.signal.aborted) {
        controller.abort(new Error("Client closed connection"));
      }
    };

    timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new Error("Request Timeout"));
      }
      if (!res.headersSent) {
        res.status(408).json({ error: "Request Timeout" });
      }
      if (typeof req.destroy === "function") {
        req.destroy();
      }
      cleanup();
    }, timeoutMs);

    res.once("finish", onFinish);
    res.once("close", onClose);
    req.once("close", onClose);
    req.once("error", onClose);

    next();
  };
}

// Support both middleware signature: app.use(requestTimeout)
// and parameterized factory: app.use(requestTimeout(30000))
export default function requestTimeout(req: Request, res: Response, next: NextFunction): void;
export default function requestTimeout(
  options?: number | RequestTimeoutOptions
): (req: Request, res: Response, next: NextFunction) => void;
export default function requestTimeout(
  reqOrOptions?: Request | number | RequestTimeoutOptions,
  res?: Response,
  next?: NextFunction
): any {
  if (
    reqOrOptions &&
    typeof (reqOrOptions as Request).get === "function" &&
    res &&
    typeof next === "function"
  ) {
    return createRequestTimeout()(reqOrOptions as Request, res, next);
  }

  const opts: RequestTimeoutOptions =
    typeof reqOrOptions === "number"
      ? { defaultTimeoutMs: reqOrOptions }
      : (reqOrOptions as RequestTimeoutOptions) ?? {};

  return createRequestTimeout(opts);
}
