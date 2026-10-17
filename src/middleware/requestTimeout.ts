import { Request, Response, NextFunction } from "express";

export interface RequestWithSignal extends Request {
  signal: AbortSignal;
}

export function getTimeoutMs(path: string): number {
  const defaultTimeout = parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10);
  const adminTimeout = parseInt(process.env.ADMIN_REQUEST_TIMEOUT_MS || "60000", 10);
  const effectiveDefault = Number.isFinite(defaultTimeout) && defaultTimeout > 0 ? defaultTimeout : 30000;
  const effectiveAdmin = Number.isFinite(adminTimeout) && adminTimeout > 0 ? adminTimeout : 60000;
  return path.startsWith("/admin") ? effectiveAdmin : effectiveDefault;
}

export default function requestTimeout(req: Request, res: Response, next: NextFunction) {
  const timeoutMs = getTimeoutMs(req.path);
  const abortController = new AbortController();

  // Attach AbortSignal to req so downstream handlers can cancel expensive work
  (req as RequestWithSignal).signal = abortController.signal;

  let timerCleared = false;
  const timer = setTimeout(() => {
    timerCleared = true;
    abortController.abort(new Error("Request Timeout"));
    if (!res.headersSent) res.status(408).json({ error: "Request Timeout" });
    req.destroy();
  }, timeoutMs);

  const cleanup = () => {
    if (!timerCleared) {
      clearTimeout(timer);
      timerCleared = true;
    }
  };

  const handleClose = () => {
    cleanup();
    // If client disconnected before response finished, abort downstream work
    if (!res.writableEnded) {
      abortController.abort(new Error("Client disconnected"));
    }
  };

  res.once("finish", cleanup);
  res.once("close", handleClose);
  next();
}
