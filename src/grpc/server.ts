import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { getSolarData, getSatelliteData } from "../routes/iot";
import { computeScores } from "../lib/scoring";
import { getTotalProjects } from "../lib/registry";
import { validateApiKey, isRateLimited, incrementUsage } from "../lib/apiKeys";
import { scoreEvents, SCORE_UPDATE_EVENT } from "../lib/events";
import { handleListenError } from "../lib/listen-errors";
import { logger } from "../lib/logger";
import { timingSafeCompare } from "../lib/timing-safe";

const PROTO_PATH = path.join(__dirname, "../proto/heliobond.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const heliobondProto = grpc.loadPackageDefinition(packageDefinition).heliobond as any;
const MAX_INITIAL_SNAPSHOT_PROJECTS = 1000;
const MAX_BUFFERED_SNAPSHOT_UPDATES = 1000;

type GrpcAuthResult =
  | { success: true }
  | {
      success: false;
      reason: "missing" | "invalid" | "quota_exhausted";
      error: string;
      retryAfterSeconds?: number;
    };

function authenticateGrpc(metadata: grpc.Metadata): GrpcAuthResult {
  const authHeader = metadata.get("authorization")[0] as string | undefined;
  const apiKeyHeader = metadata.get("x-api-key")[0] as string | undefined;
  let providedKey = "";

  if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  } else if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.substring(7);
  }

  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && timingSafeCompare(providedKey, adminKey)) {
    return { success: true };
  }

  if (!providedKey) {
    return {
      success: false,
      reason: "missing",
      error: "Missing API key in metadata (authorization or x-api-key)",
    };
  }

  const keyRecord = validateApiKey(providedKey);
  if (!keyRecord) {
    return { success: false, reason: "invalid", error: "Invalid or revoked API key" };
  }

  if (isRateLimited(keyRecord.id, keyRecord.rate_limit)) {
    return {
      success: false,
      reason: "quota_exhausted",
      error: "Rate limit exceeded for this API key. Please retry later.",
      retryAfterSeconds: Math.max(1, Math.ceil((60000 - (Date.now() % 60000)) / 1000)),
    };
  }

  incrementUsage(keyRecord.id);
  return { success: true };
}

function grpcAuthError(auth: Extract<GrpcAuthResult, { success: false }>): grpc.ServiceError {
  const err = new Error(auth.error) as grpc.ServiceError;
  err.code =
    auth.reason === "quota_exhausted"
      ? grpc.status.RESOURCE_EXHAUSTED
      : grpc.status.UNAUTHENTICATED;
  err.details = auth.error;
  err.metadata = new grpc.Metadata();
  if (auth.retryAfterSeconds !== undefined) {
    err.metadata.add("retry-after", String(auth.retryAfterSeconds));
    err.metadata.add("grpc-retry-pushback-ms", String(auth.retryAfterSeconds * 1000));
  }
  return err;
}

// Helper to get score details for a project
function getProjectDetails(id: number) {
  const solar = getSolarData(id);
  const satellite = getSatelliteData(id);
  const scores = computeScores({ solar, satellite });
  return {
    project_id: id,
    credit_quality: scores.credit_quality,
    green_impact: scores.green_impact,
    power_output_kw: solar.power_output_kw,
    efficiency_pct: solar.efficiency_pct,
    forest_density_pct: satellite.forest_density_pct,
    ndvi_score: satellite.ndvi_score,
    timestamp: Math.max(solar.timestamp, satellite.timestamp),
  };
}

// Unary handler
async function getProjectScore(
  call: grpc.ServerUnaryCall<any, any>,
  callback: grpc.sendUnaryData<any>,
) {
  try {
    const auth = authenticateGrpc(call.metadata);
    if (!auth.success) {
      return callback(grpcAuthError(auth));
    }

    const { project_id } = call.request;
    const total = await getTotalProjects();
    if (project_id < 1 || project_id > total) {
      return callback({
        code: grpc.status.NOT_FOUND,
        details: `Project with ID ${project_id} not found`,
      });
    }

    const data = getProjectDetails(project_id);
    callback(null, data);
  } catch (error: unknown) {
    logger.error("[gRPC] GetProjectScore failed", logger.formatError(error));
    callback({
      code: grpc.status.INTERNAL,
      details: "Internal server error",
    });
  }
}

// Server streaming handler (pushes real-time score updates)
function streamProjectScores(call: grpc.ServerWritableStream<any, any>) {
  const auth = authenticateGrpc(call.metadata);
  if (!auth.success) {
    call.destroy(grpcAuthError(auth));
    return;
  }

  let snapshotting = call.request.include_initial_snapshot === true;
  const bufferedUpdates = new Map<number, { project_id: number }>();
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    scoreEvents.off(SCORE_UPDATE_EVENT, listener);
    call.off("cancelled", cleanup);
    call.off("close", cleanup);
  };

  const listener = (update: { project_id: number }) => {
    if (snapshotting) {
      if (
        !bufferedUpdates.has(update.project_id) &&
        bufferedUpdates.size >= MAX_BUFFERED_SNAPSHOT_UPDATES
      ) {
        const err = new Error(
          "Too many score updates during initial snapshot",
        ) as grpc.ServiceError;
        err.code = grpc.status.RESOURCE_EXHAUSTED;
        err.details = "Initial snapshot could not keep up with live score updates";
        cleanup();
        call.destroy(err);
        return;
      }
      bufferedUpdates.set(update.project_id, update);
      return;
    }

    try {
      const details = getProjectDetails(update.project_id);
      call.write(details);
    } catch (error) {
      logger.error("[gRPC Stream] failed to send project details", {
        stream_type: "streamProjectScores",
        project_id: update.project_id,
        ...logger.formatError(error),
      });
    }
  };

  scoreEvents.on(SCORE_UPDATE_EVENT, listener);

  call.on("cancelled", cleanup);
  call.on("close", cleanup);
  call.on("error", (err) => {
    logger.error("[gRPC Stream] stream error", {
      stream_type: "streamProjectScores",
      error_code: (err as grpc.ServiceError).code,
      ...logger.formatError(err),
    });
    cleanup();
  });

  if (snapshotting) {
    void (async () => {
      try {
        const total = await getTotalProjects();
        if (total > MAX_INITIAL_SNAPSHOT_PROJECTS) {
          const err = new Error(
            "Initial score snapshot exceeds the supported size",
          ) as grpc.ServiceError;
          err.code = grpc.status.RESOURCE_EXHAUSTED;
          err.details = `Initial snapshot is limited to ${MAX_INITIAL_SNAPSHOT_PROJECTS} projects`;
          cleanup();
          call.destroy(err);
          return;
        }

        for (let projectId = 1; projectId <= total && !closed; projectId++) {
          call.write(getProjectDetails(projectId));
        }

        while (!closed && bufferedUpdates.size > 0) {
          const update = bufferedUpdates.values().next().value as { project_id: number };
          bufferedUpdates.delete(update.project_id);
          call.write(getProjectDetails(update.project_id));
        }
        snapshotting = false;
      } catch (error) {
        logger.error("[gRPC Stream] initial snapshot failed", logger.formatError(error));
        const err = new Error("Unable to load initial score snapshot") as grpc.ServiceError;
        err.code = grpc.status.INTERNAL;
        err.details = "Unable to load initial score snapshot";
        cleanup();
        call.destroy(err);
      }
    })();
  }
}

// Bidirectional streaming handler
function chatProjectScores(call: grpc.ServerDuplexStream<any, any>) {
  const auth = authenticateGrpc(call.metadata);
  if (!auth.success) {
    call.destroy(grpcAuthError(auth));
    return;
  }

  call.on("error", (err) => {
    logger.error("[gRPC Chat] stream error", {
      stream_type: "chatProjectScores",
      error_code: (err as grpc.ServiceError).code,
      ...logger.formatError(err),
    });
  });

  call.on("data", async (request) => {
    const { project_id } = request;
    try {
      const total = await getTotalProjects();
      if (project_id < 1 || project_id > total) {
        call.write({
          project_id,
          timestamp: Date.now(),
          credit_quality: 0,
          green_impact: 0,
        });
        return;
      }

      const details = getProjectDetails(project_id);
      call.write(details);
    } catch (error: unknown) {
      logger.error("[gRPC Chat] data processing error", {
        stream_type: "chatProjectScores",
        project_id,
        ...logger.formatError(error),
      });
      const err = new Error("Internal server error") as grpc.ServiceError;
      err.code = grpc.status.INTERNAL;
      err.details = "Internal server error";
      call.destroy(err);
    }
  });

  call.on("end", () => {
    call.end();
  });
}

export function startGrpcServer(
  port: number = 50051,
  handleBindError: (err: NodeJS.ErrnoException, port: number | string) => void = handleListenError,
): grpc.Server {
  const server = new grpc.Server({
    "grpc.keepalive_time_ms": 120000,
    "grpc.keepalive_timeout_ms": 20000,
    "grpc.keepalive_permit_without_calls": 1,
    "grpc.max_connection_idle_ms": 300000,
  });

  server.addService(heliobondProto.HeliobondService.service, {
    GetProjectScore: getProjectScore,
    StreamProjectScores: streamProjectScores,
    ChatProjectScores: chatProjectScores,
  });

  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
    if (err) {
      handleBindError(err as NodeJS.ErrnoException, port);
      return;
    }
    logger.info(`[gRPC] Server running on 0.0.0.0:${boundPort}`);
  });

  return server;
}
