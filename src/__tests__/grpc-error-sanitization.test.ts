import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { startGrpcServer, GRPC_INTERNAL_ERROR_MESSAGE } from "../grpc/server";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import { clearApiKeys, generateApiKey } from "../lib/apiKeys";
import { scoreEvents, SCORE_UPDATE_EVENT } from "../lib/events";
import { logger } from "../lib/logger";

jest.mock("../lib/registry", () => ({
  getTotalProjects: jest.fn(),
}));
jest.mock("../routes/iot");
jest.mock("../lib/scoring");

const PROTO_PATH = path.join(__dirname, "../proto/heliobond.proto");
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const heliobondProto = grpc.loadPackageDefinition(packageDefinition).heliobond as any;

describe("gRPC Error Handler Hardening and Anti-Leak Matrix (#923)", () => {
  let server: grpc.Server;
  let client: any;
  let consumerKey: string;
  let loggerErrorSpy: jest.SpyInstance;
  const PORT = 50058;

  beforeAll((done) => {
    process.env.ADMIN_API_KEY = "grpc-admin-test-key";
    server = startGrpcServer(PORT);
    client = new heliobondProto.HeliobondService(
      `localhost:${PORT}`,
      grpc.credentials.createInsecure(),
    );
    setTimeout(done, 500);
  });

  afterAll((done) => {
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        done();
      }
    };
    try {
      client.close();
      server.tryShutdown(() => finish());
    } catch {
      finish();
    }
    setTimeout(() => {
      try {
        server.forceShutdown();
      } catch {
        // ignore
      }
      finish();
    }, 200);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    clearApiKeys();
    const key = generateApiKey("gRPC Auditor");
    consumerKey = key.key;

    (registry.getTotalProjects as jest.Mock).mockResolvedValue(10);
    (iot.getSolarData as jest.Mock).mockReturnValue({
      power_output_kw: 500,
      efficiency_pct: 80,
      max_power_kw: 1000,
      timestamp: 12345678,
    });
    (iot.getSatelliteData as jest.Mock).mockReturnValue({
      forest_density_pct: 75,
      ndvi_score: 0.7,
      timestamp: 12345678,
    });
    (scoring.computeScores as jest.Mock).mockReturnValue({
      credit_quality: 90,
      green_impact: 85,
    });

    loggerErrorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  // =========================================================================
  // Dimension 1: Sensitive Error String Containment Matrix
  // =========================================================================
  describe("Dimension 1: Sensitive error string containment and leak prevention", () => {
    const sensitiveErrorStrings = [
      "FATAL: password authentication failed for user 'postgres'",
      "Connection to db-internal.internal.heliobond.io:5432 refused",
      "Stellar Soroban RPC key 'SB2Y...SECRET' expired on contract CABC123",
      "Failed to read /etc/heliobond/secrets/master.key: permission denied",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY invalid",
      "SyntaxError: Unexpected token < in JSON at position 0 at parseConfig (/app/src/db.ts:42:15)",
      "ENOTFOUND redis-cache.prod.cluster.local:6379",
      "SELECT * FROM users WHERE api_key = 'sec_123456' -- syntax error near 'sec_123456'",
      "Error: Contract invocation failed: [HostError: Error(WasmVm, IndexOutOfBounds)] at SorobanRPC.call",
      "Memory leak detected at Buffer.allocUnsafe(104857600): heap limit reached",
      "Error: Invalid HMAC signature '9a8b7c6d5e' using secret 'super-secret-seed'",
      "Unhandled rejection: Error at Object.<anonymous> (/var/www/backend/src/lib/stellar.ts:112:19)",
    ];

    it.each(sensitiveErrorStrings)(
      "masks sensitive error and prevents leakage: %s",
      (sensitiveMsg, done) => {
        (registry.getTotalProjects as jest.Mock).mockRejectedValueOnce(new Error(sensitiveMsg));

        const meta = new grpc.Metadata();
        meta.add("x-api-key", consumerKey);

        client.GetProjectScore({ project_id: 1 }, meta, (err: any, response: any) => {
          expect(response).toBeUndefined();
          expect(err).toBeDefined();
          expect(err.code).toBe(grpc.status.INTERNAL);
          expect(err.details).toBe(GRPC_INTERNAL_ERROR_MESSAGE);
          expect(err.details).not.toContain(sensitiveMsg);
          expect(err.details).not.toContain("password");
          expect(err.details).not.toContain("internal");
          expect(err.details).not.toContain("SECRET");
          expect(err.details).not.toContain(".ts");

          // Verifies server-side logging captured the actual failure
          expect(loggerErrorSpy).toHaveBeenCalled();
          const logCall = loggerErrorSpy.mock.calls[0];
          expect(logCall[0]).toContain("[gRPC] getProjectScore internal error");
          expect(JSON.stringify(logCall[1])).toContain(sensitiveMsg);
          done();
        });
      },
    );
  });

  // =========================================================================
  // Dimension 2: Combinatorics of Thrown Types and Error Classes
  // =========================================================================
  describe("Dimension 2: Thrown error types and variations", () => {
    const errorClasses = [
      {
        desc: "TypeError",
        err: new TypeError("Cannot read properties of undefined (reading 'score')"),
      },
      { desc: "RangeError", err: new RangeError("Maximum call stack size exceeded") },
      { desc: "ReferenceError", err: new ReferenceError("internalConnectionPool is not defined") },
      { desc: "SyntaxError", err: new SyntaxError("Unexpected identifier in eval") },
      { desc: "Custom non-Error object", err: { customCode: 500, detail: "low level failure" } },
      { desc: "Raw string exception", err: "raw thrown string error" },
      { desc: "Numeric thrown value", err: 5001 },
      { desc: "Null thrown value", err: null },
      { desc: "Undefined thrown value", err: undefined },
    ];

    it.each(errorClasses)(
      "consistently returns generic internal error for $desc",
      ({ err }, done) => {
        (registry.getTotalProjects as jest.Mock).mockImplementationOnce(() => {
          throw err;
        });

        const meta = new grpc.Metadata();
        meta.add("x-api-key", consumerKey);

        client.GetProjectScore({ project_id: 1 }, meta, (grpcErr: any, response: any) => {
          expect(response).toBeUndefined();
          expect(grpcErr).toBeDefined();
          expect(grpcErr.code).toBe(grpc.status.INTERNAL);
          expect(grpcErr.details).toBe(GRPC_INTERNAL_ERROR_MESSAGE);
          expect(loggerErrorSpy).toHaveBeenCalled();
          done();
        });
      },
    );
  });

  // =========================================================================
  // Dimension 3: Subsystem Variations and Handlers (Unary, Server Stream, Duplex)
  // =========================================================================
  describe("Dimension 3: Subsystem handler coverage (getSolarData, computeScores, streaming)", () => {
    it("handles error thrown inside getSolarData safely", (done) => {
      (iot.getSolarData as jest.Mock).mockImplementationOnce(() => {
        throw new Error("Solar inverter modbus timeout at 192.168.1.100:502");
      });

      const meta = new grpc.Metadata();
      meta.add("x-api-key", consumerKey);

      client.GetProjectScore({ project_id: 1 }, meta, (err: any) => {
        expect(err.code).toBe(grpc.status.INTERNAL);
        expect(err.details).toBe(GRPC_INTERNAL_ERROR_MESSAGE);
        expect(err.details).not.toContain("192.168.1.100");
        expect(loggerErrorSpy).toHaveBeenCalled();
        done();
      });
    });

    it("handles error thrown inside getSatelliteData safely", (done) => {
      (iot.getSatelliteData as jest.Mock).mockImplementationOnce(() => {
        throw new Error("Sentinel-2 API key 'SEN2_SEC_99' quota exceeded");
      });

      const meta = new grpc.Metadata();
      meta.add("x-api-key", consumerKey);

      client.GetProjectScore({ project_id: 1 }, meta, (err: any) => {
        expect(err.code).toBe(grpc.status.INTERNAL);
        expect(err.details).toBe(GRPC_INTERNAL_ERROR_MESSAGE);
        expect(err.details).not.toContain("SEN2_SEC_99");
        expect(loggerErrorSpy).toHaveBeenCalled();
        done();
      });
    });

    it("handles error thrown inside computeScores safely", (done) => {
      (scoring.computeScores as jest.Mock).mockImplementationOnce(() => {
        throw new Error("Scoring formula division by zero in ndvi weight matrix");
      });

      const meta = new grpc.Metadata();
      meta.add("x-api-key", consumerKey);

      client.GetProjectScore({ project_id: 1 }, meta, (err: any) => {
        expect(err.code).toBe(grpc.status.INTERNAL);
        expect(err.details).toBe(GRPC_INTERNAL_ERROR_MESSAGE);
        expect(err.details).not.toContain("division by zero");
        expect(loggerErrorSpy).toHaveBeenCalled();
        done();
      });
    });

    it("destroys stream with generic error when streaming listener throws", (done) => {
      (iot.getSolarData as jest.Mock).mockImplementationOnce(() => {
        throw new Error("Stream worker panic at /internal/worker.ts:88");
      });

      const meta = new grpc.Metadata();
      meta.add("authorization", "Bearer grpc-admin-test-key");

      const stream = client.StreamProjectScores({}, meta);
      stream.on("error", (err: any) => {
        expect(err.code).toBe(grpc.status.INTERNAL);
        expect(err.details).toBe(GRPC_INTERNAL_ERROR_MESSAGE);
        expect(err.details).not.toContain("Stream worker panic");
        expect(loggerErrorSpy).toHaveBeenCalled();
        done();
      });

      setTimeout(() => {
        scoreEvents.emit(SCORE_UPDATE_EVENT, { project_id: 1 });
      }, 50);
    });

    it("destroys duplex chat with generic error when processing data throws", (done) => {
      (iot.getSolarData as jest.Mock).mockImplementationOnce(() => {
        throw new Error("Duplex worker failed to parse frame payload");
      });

      const meta = new grpc.Metadata();
      meta.add("x-api-key", consumerKey);

      const stream = client.ChatProjectScores(meta);
      stream.on("error", (err: any) => {
        expect(err.code).toBe(grpc.status.INTERNAL);
        expect(err.details).toBe(GRPC_INTERNAL_ERROR_MESSAGE);
        expect(err.details).not.toContain("Duplex worker failed");
        expect(loggerErrorSpy).toHaveBeenCalled();
        done();
      });

      stream.write({ project_id: 1 });
    });
  });

  // =========================================================================
  // Dimension 4: Negative Controls & Non-Internal Error Distinctions
  // =========================================================================
  describe("Dimension 4: Negative controls - valid calls and legitimate error statuses", () => {
    it("returns NOT_FOUND with descriptive message for nonexistent project", (done) => {
      const meta = new grpc.Metadata();
      meta.add("x-api-key", consumerKey);

      client.GetProjectScore({ project_id: 999 }, meta, (err: any) => {
        expect(err).toBeDefined();
        expect(err.code).toBe(grpc.status.NOT_FOUND);
        expect(err.details).toBe("Project with ID 999 not found");
        // Legitimate business error does NOT trigger logger.error
        expect(loggerErrorSpy).not.toHaveBeenCalled();
        done();
      });
    });

    it("returns UNAUTHENTICATED when token is invalid", (done) => {
      const meta = new grpc.Metadata();
      meta.add("x-api-key", "invalid-key-xyz");

      client.GetProjectScore({ project_id: 1 }, meta, (err: any) => {
        expect(err).toBeDefined();
        expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
        expect(err.details).toBe("Invalid or revoked API key");
        expect(loggerErrorSpy).not.toHaveBeenCalled();
        done();
      });
    });

    it("returns UNAUTHENTICATED when authorization header is missing", (done) => {
      client.GetProjectScore({ project_id: 1 }, (err: any) => {
        expect(err).toBeDefined();
        expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
        expect(err.details).toContain("Missing API key in metadata");
        expect(loggerErrorSpy).not.toHaveBeenCalled();
        done();
      });
    });

    it("preserves successful response structure when no error occurs", (done) => {
      const meta = new grpc.Metadata();
      meta.add("x-api-key", consumerKey);

      client.GetProjectScore({ project_id: 1 }, meta, (err: any, resp: any) => {
        expect(err).toBeNull();
        expect(resp).toBeDefined();
        expect(resp.project_id).toBe(1);
        expect(resp.credit_quality).toBe(90);
        expect(resp.green_impact).toBe(85);
        expect(loggerErrorSpy).not.toHaveBeenCalled();
        done();
      });
    });
  });

  // =========================================================================
  // Dimension 5: Parameterized Stress and Sequential Calls
  // =========================================================================
  describe("Dimension 5: Stress burst execution and state isolation", () => {
    const errorIterations = Array.from({ length: 85 }, (_, i) => ({
      index: i,
      leakToken: `TOKEN_SECRET_LEAK_${i}_X99`,
    }));

    it.each(errorIterations)(
      "correctly masks and logs failure iteration #$index",
      ({ leakToken }, done) => {
        (registry.getTotalProjects as jest.Mock).mockRejectedValueOnce(
          new Error(`Simulated database fault ${leakToken}`),
        );

        const meta = new grpc.Metadata();
        meta.add("x-api-key", consumerKey);

        client.GetProjectScore({ project_id: 1 }, meta, (err: any) => {
          expect(err.code).toBe(grpc.status.INTERNAL);
          expect(err.details).toBe(GRPC_INTERNAL_ERROR_MESSAGE);
          expect(err.details).not.toContain(leakToken);
          done();
        });
      },
    );

    it("recovers immediately after errors and serves successful calls", (done) => {
      (registry.getTotalProjects as jest.Mock).mockRejectedValueOnce(
        new Error("Temporary transient connection failure"),
      );

      const meta = new grpc.Metadata();
      meta.add("x-api-key", consumerKey);

      // First call fails with generic internal error
      client.GetProjectScore({ project_id: 1 }, meta, (err1: any) => {
        expect(err1.code).toBe(grpc.status.INTERNAL);
        expect(err1.details).toBe(GRPC_INTERNAL_ERROR_MESSAGE);

        // Second call succeeds normally
        client.GetProjectScore({ project_id: 1 }, meta, (err2: any, resp2: any) => {
          expect(err2).toBeNull();
          expect(resp2).toBeDefined();
          expect(resp2.credit_quality).toBe(90);
          done();
        });
      });
    });
  });
});
