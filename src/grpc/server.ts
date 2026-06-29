import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { randomUUID } from "crypto";
import { getSolarData, getSatelliteData } from "../routes/iot";
import { computeScores } from "../lib/scoring";
import { getTotalProjects } from "../lib/registry";
import { validateApiKey, isRateLimited, incrementUsage } from "../lib/apiKeys";
import { scoreEvents, SCORE_UPDATE_EVENT } from "../lib/events";
import { runWithCorrelationId } from "../lib/correlation";
import { logger } from "../lib/logger";

const PROTO_PATH = path.join(__dirname, "../proto/heliobond.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const heliobondProto = grpc.loadPackageDefinition(packageDefinition).heliobond as any;

// Helper to authenticate metadata
function authenticateGrpc(metadata: grpc.Metadata): { success: boolean; error?: string } {
  const authHeader = metadata.get("authorization")[0] as string | undefined;
  const apiKeyHeader = metadata.get("x-api-key")[0] as string | undefined;
  let providedKey = "";

  if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  } else if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.substring(7);
  }

  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && providedKey === adminKey) {
    return { success: true };
  }

  if (!providedKey) {
    return { success: false, error: "Missing API key in metadata (authorization or x-api-key)" };
  }

  const keyRecord = validateApiKey(providedKey);
  if (!keyRecord) {
    return { success: false, error: "Invalid or revoked API key" };
  }

  if (isRateLimited(keyRecord.id, keyRecord.rate_limit)) {
    return { success: false, error: "Rate limit exceeded" };
  }

  incrementUsage(keyRecord.id);
  return { success: true };
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

function extractCorrelationId(metadata: grpc.Metadata): string {
  return (metadata.get("x-correlation-id")[0] as string | undefined) || randomUUID();
}

// Unary handler
async function getProjectScore(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
  const correlationId = extractCorrelationId(call.metadata);
  await runWithCorrelationId(correlationId, async () => {
    try {
      const auth = authenticateGrpc(call.metadata);
      if (!auth.success) {
        return callback({ code: grpc.status.UNAUTHENTICATED, details: auth.error });
      }

      const { project_id } = call.request;
      const total = await getTotalProjects();
      if (project_id < 1 || project_id > total) {
        return callback({ code: grpc.status.NOT_FOUND, details: `Project with ID ${project_id} not found` });
      }

      logger.info("[gRPC] GetProjectScore", { project_id });
      const data = getProjectDetails(project_id);
      callback(null, data);
    } catch (error: any) {
      logger.error("[gRPC] GetProjectScore failed", { error: error.message });
      callback({ code: grpc.status.INTERNAL, details: error.message || "Internal server error" });
    }
  });
}

// Server streaming handler (pushes real-time score updates)
function streamProjectScores(call: grpc.ServerWritableStream<any, any>) {
  const correlationId = extractCorrelationId(call.metadata);
  runWithCorrelationId(correlationId, () => {
    const auth = authenticateGrpc(call.metadata);
    if (!auth.success) {
      const err = new Error(auth.error || "Authentication failed") as grpc.ServiceError;
      err.code = grpc.status.UNAUTHENTICATED;
      call.destroy(err);
      return;
    }

    logger.info("[gRPC] StreamProjectScores started");

    const listener = (update: any) => {
      runWithCorrelationId(correlationId, () => {
        try {
          const details = getProjectDetails(update.project_id);
          call.write(details);
        } catch (err: any) {
          logger.error("[gRPC] Stream write failed", { error: err?.message });
        }
      });
    };

    scoreEvents.on(SCORE_UPDATE_EVENT, listener);
    call.on("cancelled", () => {
      scoreEvents.off(SCORE_UPDATE_EVENT, listener);
      logger.info("[gRPC] StreamProjectScores cancelled");
    });
  });
}

// Bidirectional streaming handler
function chatProjectScores(call: grpc.ServerDuplexStream<any, any>) {
  const correlationId = extractCorrelationId(call.metadata);
  runWithCorrelationId(correlationId, () => {
    const auth = authenticateGrpc(call.metadata);
    if (!auth.success) {
      const err = new Error(auth.error || "Authentication failed") as grpc.ServiceError;
      err.code = grpc.status.UNAUTHENTICATED;
      call.destroy(err);
      return;
    }

    logger.info("[gRPC] ChatProjectScores started");

    call.on("data", async (request) => {
      await runWithCorrelationId(correlationId, async () => {
        try {
          const { project_id } = request;
          const total = await getTotalProjects();
          if (project_id < 1 || project_id > total) {
            call.write({ project_id, timestamp: Date.now(), credit_quality: 0, green_impact: 0 });
            return;
          }
          const details = getProjectDetails(project_id);
          call.write(details);
        } catch (err: any) {
          logger.error("[gRPC] Chat data error", { error: err?.message });
        }
      });
    });

    call.on("end", () => {
      call.end();
    });
  });
}

export function startGrpcServer(port = 50051): grpc.Server {
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

  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err: Error | null, boundPort: number) => {
    if (err) {
      logger.error(`[gRPC] Failed to bind to port ${port}`, { error: err.message });
      return;
    }
    logger.info(`[gRPC] Server running on 0.0.0.0:${boundPort}`);
  });

  return server;
}
