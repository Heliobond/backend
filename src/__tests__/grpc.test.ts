import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { startGrpcServer } from "../grpc/server";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import { clearApiKeys, generateApiKey } from "../lib/apiKeys";
import { scoreEvents, SCORE_UPDATE_EVENT } from "../lib/events";

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

describe("gRPC Service Integration", () => {
  let server: grpc.Server;
  let client: any;
  let consumerKey: string;
  const PORT = 50055;

  beforeAll((done) => {
    process.env.ADMIN_API_KEY = "grpc-admin-key";
    server = startGrpcServer(PORT);

    client = new heliobondProto.HeliobondService(
      `localhost:${PORT}`,
      grpc.credentials.createInsecure()
    );
    // Give the server a small moment to bind
    setTimeout(done, 500);
  });

  afterAll((done) => {
    client.close();
    server.tryShutdown(() => {
      done();
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    clearApiKeys();
    const key = generateApiKey("gRPC Consumer");
    consumerKey = key.key;

    (registry.getTotalProjects as jest.Mock).mockResolvedValue(2);
    (iot.getSolarData as jest.Mock).mockImplementation((id: number) => ({
      power_output_kw: 650,
      efficiency_pct: 85,
      max_power_kw: 1000,
      timestamp: 12345678,
    }));
    (iot.getSatelliteData as jest.Mock).mockImplementation((id: number) => ({
      forest_density_pct: 80,
      ndvi_score: 0.8,
      timestamp: 12345678,
    }));
    (scoring.computeScores as jest.Mock).mockImplementation(() => ({
      credit_quality: 92,
      green_impact: 82,
    }));
  });

  it("should reject unary calls without authentication metadata", (done) => {
    client.GetProjectScore({ project_id: 1 }, (err: any, response: any) => {
      expect(err).toBeDefined();
      expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
      expect(response).toBeUndefined();
      done();
    });
  });

  it("should allow unary calls with valid consumer key in metadata", (done) => {
    const meta = new grpc.Metadata();
    meta.add("x-api-key", consumerKey);

    client.GetProjectScore({ project_id: 1 }, meta, (err: any, response: any) => {
      expect(err).toBeNull();
      expect(response).toEqual({
        project_id: 1,
        credit_quality: 92,
        green_impact: 82,
        power_output_kw: 650,
        efficiency_pct: 85,
        forest_density_pct: 80,
        ndvi_score: 0.8,
        timestamp: "12345678",
      });
      done();
    });
  });

  it("should stream project scores", (done) => {
    const meta = new grpc.Metadata();
    meta.add("authorization", `Bearer grpc-admin-key`);

    const stream = client.StreamProjectScores({}, meta);
    const received: any[] = [];

    stream.on("error", (err: any) => {
      // Ignore cancellation error since we cancelled it ourselves
      if (err.code !== grpc.status.CANCELLED) {
        done(err);
      }
    });

    stream.on("data", (data: any) => {
      received.push(data);
      if (received.length === 1) {
        expect(received[0].project_id).toBe(2);
        stream.cancel();
        done();
      }
    });

    // Simulate event emit in the background
    setTimeout(() => {
      scoreEvents.emit(SCORE_UPDATE_EVENT, { project_id: 2 });
    }, 100);
  });

  it("should handle bidirectional chat project scores", (done) => {
    const meta = new grpc.Metadata();
    meta.add("x-api-key", consumerKey);

    const stream = client.ChatProjectScores(meta);
    const received: any[] = [];

    stream.on("error", (err: any) => {
      done(err);
    });

    stream.on("data", (data: any) => {
      received.push(data);
      if (received.length === 2) {
        expect(received[0].project_id).toBe(1);
        expect(received[0].credit_quality).toBe(92);
        expect(received[1].project_id).toBe(2);
        expect(received[1].credit_quality).toBe(92);
        stream.end();
        done();
      }
    });

    stream.write({ project_id: 1 });
    stream.write({ project_id: 2 });
  });
});
