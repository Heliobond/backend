import { logger } from "./logger";

type ApmProvider = "datadog" | "newrelic" | "opentelemetry" | "none";

function getApmProvider(): ApmProvider {
  const provider = (process.env.APM_PROVIDER || "none").toLowerCase() as ApmProvider;
  return ["datadog", "newrelic", "opentelemetry", "none"].includes(provider) ? provider : "none";
}

export async function initApm(): Promise<void> {
  const provider = getApmProvider();

  switch (provider) {
    case "datadog":
      await initDatadog();
      break;
    case "newrelic":
      await initNewRelic();
      break;
    case "opentelemetry":
      await initOpenTelemetry();
      break;
    case "none":
    default:
      logger.info("APM disabled (APM_PROVIDER=none)");
      break;
  }
}

async function initDatadog(): Promise<void> {
  try {
    const ddTrace = await import("dd-trace").catch(() => null);
    if (ddTrace) {
      ddTrace.default.init({
        service: process.env.DD_SERVICE || "heliobond-backend",
        env: process.env.DD_ENV || "development",
        version: process.env.DD_VERSION || "1.0.0",
        hostname: process.env.DD_AGENT_HOST || "localhost",
      });
      logger.info("DataDog APM initialized");
    } else {
      logger.warn("dd-trace package not installed, DataDog APM disabled");
    }
  } catch (err: any) {
    logger.error("Failed to initialize DataDog APM", { error: err?.message });
  }
}

async function initNewRelic(): Promise<void> {
  try {
    const newrelic = await import("newrelic").catch(() => null);
    if (newrelic) {
      logger.info("New Relic APM initialized");
    } else {
      logger.warn("newrelic package not installed, New Relic APM disabled");
    }
  } catch (err: any) {
    logger.error("Failed to initialize New Relic APM", { error: err?.message });
  }
}

async function initOpenTelemetry(): Promise<void> {
  try {
    const sdkModule = await import("@opentelemetry/sdk-node");
    const autoInstrModule = await import("@opentelemetry/auto-instrumentations-node");
    const otlpModule = await import("@opentelemetry/exporter-trace-otlp-http");
    const zipkinModule = await import("@opentelemetry/exporter-zipkin");
    const resourceModule = await import("@opentelemetry/resources");
    const semconvModule = await import("@opentelemetry/semantic-conventions");

    const { NodeSDK } = sdkModule;
    const { getNodeAutoInstrumentations } = autoInstrModule;
    const { OTLPTraceExporter } = otlpModule;
    const { ZipkinExporter } = zipkinModule;

    const serviceName = process.env.OTEL_SERVICE_NAME || "heliobond-backend";
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
    const zipkinEndpoint = process.env.OTEL_ZIPKIN_ENDPOINT || "http://localhost:9411";

    // Build resource with service identity
    const resource = resourceModule.resourceFromAttributes({
      [semconvModule.ATTR_SERVICE_NAME]: serviceName,
      [semconvModule.ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "1.0.0",
      "deployment.environment": process.env.NODE_ENV || "development",
    });

    // Build exporters based on configuration
    const exporters = [];

    // OTLP exporter (Jaeger/collector) — enabled by default
    const enableOtlp = process.env.OTEL_EXPORTER_OTLP_ENABLED !== "false";
    if (enableOtlp) {
      exporters.push(
        new OTLPTraceExporter({
          url: `${otlpEndpoint}/v1/traces`,
        }),
      );
      logger.info("OpenTelemetry OTLP exporter configured", { endpoint: otlpEndpoint });
    }

    // Zipkin exporter — opt-in via OTEL_ZIPKIN_ENABLED=true
    const enableZipkin = process.env.OTEL_ZIPKIN_ENABLED === "true";
    if (enableZipkin) {
      exporters.push(
        new ZipkinExporter({
          url: zipkinEndpoint,
          serviceName,
        }),
      );
      logger.info("OpenTelemetry Zipkin exporter configured", { endpoint: zipkinEndpoint });
    }

    if (exporters.length === 0) {
      logger.warn("No OpenTelemetry exporters enabled — traces will be lost");
    }

    const sdk = new NodeSDK({
      resource,
      traceExporter: exporters.length === 1 ? exporters[0] : undefined,
      instrumentations: [
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-http": { enabled: true },
          "@opentelemetry/instrumentation-express": { enabled: true },
        }),
      ],
    });

    // Multiple exporters: add via SpanProcessors
    if (exporters.length > 1) {
      const { SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
      for (const exporter of exporters) {
        (sdk as any).addSpanProcessor(new SimpleSpanProcessor(exporter));
      }
    }

    await sdk.start();
    logger.info("OpenTelemetry tracing initialized", {
      serviceName,
      exporters: [
        enableOtlp ? "otlp" : null,
        enableZipkin ? "zipkin" : null,
      ].filter(Boolean),
    });

    // Graceful shutdown
    const shutdown = async () => {
      try {
        await sdk.shutdown();
        logger.info("OpenTelemetry tracing shut down");
      } catch (err: any) {
        logger.error("Failed to shut down OpenTelemetry", { error: err?.message });
      }
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (err: any) {
    logger.error("Failed to initialize OpenTelemetry APM", { error: err?.message });
  }
}
