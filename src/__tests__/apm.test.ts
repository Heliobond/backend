import { initApm } from "../lib/apm";
import { logger } from "../lib/logger";

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ZipkinExporter } from "@opentelemetry/exporter-zipkin";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

// dd-trace and newrelic are NOT installed in this project. When left unmocked,
// the dynamic import() inside initApm naturally rejects, which is exactly the
// "package not installed" branch. The "installed" branch is exercised by
// registering a virtual mock via jest.doMock() before calling initApm().
const mockDdInit = jest.fn();

jest.mock("../lib/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockedLogger = logger as jest.Mocked<typeof logger>;

const mockStart = jest.fn().mockResolvedValue(undefined);
const mockShutdown = jest.fn().mockResolvedValue(undefined);
const mockAddSpanProcessor = jest.fn();
jest.mock(
  "@opentelemetry/sdk-node",
  () => ({
    NodeSDK: jest.fn().mockImplementation(() => ({
      start: mockStart,
      shutdown: mockShutdown,
      addSpanProcessor: mockAddSpanProcessor,
    })),
  }),
  { virtual: true },
);
jest.mock("@opentelemetry/exporter-trace-otlp-http", () => ({ OTLPTraceExporter: jest.fn() }), {
  virtual: true,
});
jest.mock("@opentelemetry/exporter-zipkin", () => ({ ZipkinExporter: jest.fn() }), {
  virtual: true,
});
jest.mock(
  "@opentelemetry/resources",
  () => ({ resourceFromAttributes: jest.fn().mockReturnValue({}) }),
  { virtual: true },
);
jest.mock(
  "@opentelemetry/semantic-conventions",
  () => ({
    ATTR_SERVICE_NAME: "service.name",
    ATTR_SERVICE_VERSION: "service.version",
  }),
  { virtual: true },
);
jest.mock("@opentelemetry/sdk-trace-base", () => ({ SimpleSpanProcessor: jest.fn() }), {
  virtual: true,
});

// Register a virtual 'dd-trace' module that behaves like the default-exported
// init function consumed by initApm.
function mockDdtraceInstalled(): void {
  jest.doMock(
    "dd-trace",
    () => ({
      __esModule: true,
      default: { init: (...args: unknown[]) => mockDdInit(...args) },
    }),
    { virtual: true },
  );
}

const NodeSDKMock = NodeSDK as unknown as jest.Mock;

describe("initApm", () => {
  const originalEnv = { ...process.env };
  const originalOn = process.on;
  const originalError = console.error;

  beforeEach(() => {
    try {
      jest.unmock("dd-trace");
      jest.unmock("newrelic");
    } catch {
      // Ignored: dd-trace/newrelic are only ever mocked per-test, so they may
      // have no registered mock to unregister yet.
    }
    delete process.env.APM_PROVIDER;
    delete process.env.OTEL_EXPORTER_OTLP_ENABLED;
    delete process.env.OTEL_ZIPKIN_ENABLED;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_ZIPKIN_ENDPOINT;
    delete process.env.DD_SERVICE;
    delete process.env.DD_ENV;
    delete process.env.DD_VERSION;
    delete process.env.DD_AGENT_HOST;
    mockDdInit.mockReset();
    jest.clearAllMocks();
    // Silence expected error logging during negative tests.
    console.error = jest.fn();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.on = originalOn;
    console.error = originalError;
  });

  afterAll(() => {
    process.env = originalEnv;
    process.on = originalOn;
  });

  describe("provider selection", () => {
    it("defaults to 'none' when APM_PROVIDER is unset", async () => {
      await initApm();
      expect(mockedLogger.info).toHaveBeenCalledWith("APM disabled (APM_PROVIDER=none)");
    });

    it("disables APM when APM_PROVIDER=none", async () => {
      process.env.APM_PROVIDER = "none";
      await initApm();
      expect(mockedLogger.info).toHaveBeenCalledWith("APM disabled (APM_PROVIDER=none)");
      expect(mockedLogger.error).not.toHaveBeenCalled();
    });

    it("falls back to 'none' for an unknown/unsupported provider", async () => {
      process.env.APM_PROVIDER = "some-random-provider";
      await initApm();
      expect(mockedLogger.info).toHaveBeenCalledWith("APM disabled (APM_PROVIDER=none)");
    });

    it("treats the provider case-insensitively", async () => {
      process.env.APM_PROVIDER = "DATADOG";
      await initApm();
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        "dd-trace package not installed, DataDog APM disabled",
      );
    });
  });

  describe("DataDog provider", () => {
    it("initializes dd-trace with explicit configuration when installed", async () => {
      process.env.APM_PROVIDER = "datadog";
      mockDdtraceInstalled();
      process.env.DD_SERVICE = "my-service";
      process.env.DD_ENV = "staging";
      process.env.DD_VERSION = "2.0.0";
      process.env.DD_AGENT_HOST = "agent.internal";

      await initApm();

      expect(mockDdInit).toHaveBeenCalledWith({
        service: "my-service",
        env: "staging",
        version: "2.0.0",
        hostname: "agent.internal",
      });
      expect(mockedLogger.info).toHaveBeenCalledWith("DataDog APM initialized");
    });

    it("uses sensible defaults when DD_* variables are unset", async () => {
      process.env.APM_PROVIDER = "datadog";
      mockDdtraceInstalled();

      await initApm();

      expect(mockDdInit).toHaveBeenCalledWith({
        service: "heliobond-backend",
        env: "development",
        version: "1.0.0",
        hostname: "localhost",
      });
    });

    it("falls back to a warning when dd-trace is not installed", async () => {
      process.env.APM_PROVIDER = "datadog";
      await initApm();
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        "dd-trace package not installed, DataDog APM disabled",
      );
    });

    it("logs an error when dd-trace initialization throws", async () => {
      process.env.APM_PROVIDER = "datadog";
      mockDdtraceInstalled();
      mockDdInit.mockImplementation(() => {
        throw new Error("dd init failed");
      });

      await initApm();

      expect(mockedLogger.error).toHaveBeenCalledWith("Failed to initialize DataDog APM", {
        error: "dd init failed",
      });
      expect(mockedLogger.info).not.toHaveBeenCalledWith("DataDog APM initialized");
    });
  });

  describe("New Relic provider", () => {
    it("logs initialization when the newrelic package is installed", async () => {
      process.env.APM_PROVIDER = "newrelic";
      jest.doMock("newrelic", () => ({}), { virtual: true });

      await initApm();

      expect(mockedLogger.info).toHaveBeenCalledWith("New Relic APM initialized");
    });

    it("falls back to a warning when newrelic is not installed", async () => {
      process.env.APM_PROVIDER = "newrelic";
      await initApm();
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        "newrelic package not installed, New Relic APM disabled",
      );
    });
  });

  describe("OpenTelemetry provider", () => {
    beforeEach(() => {
      process.env.APM_PROVIDER = "opentelemetry";
    });

    it("starts the SDK and configures the OTLP exporter by default", async () => {
      await initApm();

      expect(NodeSDKMock).toHaveBeenCalledTimes(1);
      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(OTLPTraceExporter).toHaveBeenCalledWith({
        url: "http://localhost:4318/v1/traces",
      });
      expect(mockedLogger.info).toHaveBeenCalledWith("OpenTelemetry OTLP exporter configured", {
        endpoint: "http://localhost:4318",
      });
    });

    it("uses custom endpoint and service name when configured", async () => {
      process.env.OTEL_SERVICE_NAME = "custom-service";
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4317";

      await initApm();

      expect(OTLPTraceExporter).toHaveBeenCalledWith({
        url: "http://collector:4317/v1/traces",
      });
      expect(mockedLogger.info).toHaveBeenCalledWith("OpenTelemetry tracing initialized", {
        serviceName: "custom-service",
        exporters: ["otlp"],
      });
    });

    it("adds a Zipkin exporter when OTEL_ZIPKIN_ENABLED=true and uses span processors for multiple exporters", async () => {
      process.env.OTEL_ZIPKIN_ENABLED = "true";
      process.env.OTEL_ZIPKIN_ENDPOINT = "http://zipkin:9411";

      await initApm();

      expect(ZipkinExporter).toHaveBeenCalledWith({
        url: "http://zipkin:9411",
        serviceName: "heliobond-backend",
      });
      expect(mockedLogger.info).toHaveBeenCalledWith("OpenTelemetry Zipkin exporter configured", {
        endpoint: "http://zipkin:9411",
      });
      expect(SimpleSpanProcessor).toHaveBeenCalledTimes(2);
      expect(mockAddSpanProcessor).toHaveBeenCalledTimes(2);
      expect(mockedLogger.info).toHaveBeenCalledWith("OpenTelemetry tracing initialized", {
        serviceName: "heliobond-backend",
        exporters: ["otlp", "zipkin"],
      });
    });

    it("supports Zipkin as the only exporter", async () => {
      process.env.OTEL_EXPORTER_OTLP_ENABLED = "false";
      process.env.OTEL_ZIPKIN_ENABLED = "true";

      await initApm();

      expect(ZipkinExporter).toHaveBeenCalled();
      // A single exporter is passed via traceExporter, so no span processor is added.
      expect(SimpleSpanProcessor).not.toHaveBeenCalled();
      expect(mockedLogger.info).toHaveBeenCalledWith("OpenTelemetry tracing initialized", {
        serviceName: "heliobond-backend",
        exporters: ["zipkin"],
      });
    });

    it("warns when no exporters are enabled", async () => {
      process.env.OTEL_EXPORTER_OTLP_ENABLED = "false";
      process.env.OTEL_ZIPKIN_ENABLED = "false";

      await initApm();

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        "No OpenTelemetry exporters enabled — traces will be lost",
      );
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it("registers graceful shutdown handlers for SIGTERM and SIGINT", async () => {
      const on = jest.fn();
      process.on = on;

      await initApm();

      expect(on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
      expect(on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    });

    it("shuts the SDK down cleanly on SIGTERM", async () => {
      let sigtermHandler: (() => Promise<void>) | undefined;
      process.on = jest.fn((_event: string, handler: any) => {
        if (_event === "SIGTERM") sigtermHandler = handler;
        return process;
      });

      await initApm();
      expect(sigtermHandler).toBeDefined();

      await sigtermHandler!();
      expect(mockShutdown).toHaveBeenCalledTimes(1);
      expect(mockedLogger.info).toHaveBeenCalledWith("OpenTelemetry tracing shut down");
    });

    it("logs an error when SDK shutdown throws", async () => {
      let sigtermHandler: (() => Promise<void>) | undefined;
      process.on = jest.fn((_event: string, handler: any) => {
        if (_event === "SIGTERM") sigtermHandler = handler;
        return process;
      });
      mockShutdown.mockRejectedValueOnce(new Error("shutdown boom"));

      await initApm();
      await sigtermHandler!();

      expect(mockedLogger.error).toHaveBeenCalledWith("Failed to shut down OpenTelemetry", {
        error: "shutdown boom",
      });
    });

    it("logs an error when SDK initialization throws", async () => {
      NodeSDKMock.mockImplementationOnce(() => {
        throw new Error("sdk start failed");
      });

      await initApm();

      expect(mockedLogger.error).toHaveBeenCalledWith("Failed to initialize OpenTelemetry APM", {
        error: "sdk start failed",
      });
    });
  });
});
