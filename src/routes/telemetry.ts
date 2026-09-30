import express, { Request, Response, NextFunction, Router, RequestHandler } from "express";
import { config } from "../config";
import { errorBody } from "../middleware/errors";
import { telemetryLimiter } from "../middleware/rateLimit";
import { frontendErrorsTotal, frontendWebVital } from "../lib/prometheus";
import {
  classifyTelemetryReport,
  forwardTelemetryToOtlp,
  parseByteSize,
  scrubPii,
} from "../lib/telemetry";

/**
 * `POST /v1/telemetry` — ingest frontend error reports and Web Vitals (#770).
 *
 * Accepts:
 *  - `text/plain` — the browser sends a JSON string via `navigator.sendBeacon`
 *    with a `text/plain` Blob, so the JSON parser is applied here;
 *  - `application/json` — parsed by the global `express.json()` middleware.
 *
 * Responds `204 No Content` on success, `400` for schema failures or malformed
 * JSON, and `413` when the body exceeds `TELEMETRY_BODY_SIZE_LIMIT`.
 */
const MAX_TELEMETRY_BODY_BYTES = parseByteSize(config.TELEMETRY_BODY_SIZE_LIMIT);

function telemetryBodyLimit(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers["content-length"];
  if (raw !== undefined) {
    const length = Number(raw);
    if (Number.isFinite(length) && length > MAX_TELEMETRY_BODY_BYTES) {
      res.status(413).json(errorBody("payload_too_large", "Request body is too large"));
      return;
    }
  }
  next();
}

/** `text/plain` bodies arrive as a string; application/json is already parsed. */
function parseTelemetryBody(body: unknown): unknown {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  return body;
}

export function createTelemetryRouter(limiter: RequestHandler = telemetryLimiter): Router {
  const router = express.Router();

  // Scoped to this route so regular JSON endpoints keep the global limit.
  const textParser = express.text({
    type: ["text/plain"],
    limit: config.TELEMETRY_BODY_SIZE_LIMIT,
  });

  router.post("/", limiter, telemetryBodyLimit, textParser, (req: Request, res: Response) => {
    const parsed = parseTelemetryBody(req.body);
    if (parsed === undefined || parsed === null) {
      res
        .status(400)
        .json(errorBody("invalid_telemetry", "Request body is not valid telemetry JSON"));
      return;
    }

    // Second scrub pass: strip Stellar keys/XDR/e-mail before anything is
    // validated into a metric label, exported, or (optionally) traced.
    const classified = classifyTelemetryReport(scrubPii(parsed));
    if (!classified) {
      res
        .status(400)
        .json(errorBody("invalid_telemetry", "Telemetry payload does not match a known schema"));
      return;
    }

    if (classified.type === "error") {
      frontendErrorsTotal.inc({
        kind: classified.report.kind,
        contract_error_name: classified.report.contractErrorName ?? "none",
      });
    } else {
      frontendWebVital.observe(
        { name: classified.report.name, rating: classified.report.rating },
        classified.report.value,
      );
    }

    forwardTelemetryToOtlp(classified);
    res.status(204).end();
  });

  return router;
}

export default createTelemetryRouter();
