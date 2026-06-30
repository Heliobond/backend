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
    const { NodeSDK } = await import("@opentelemetry/sdk-node").catch(() => null as any);
    const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node").catch(
      () => null as any,
    );
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http").catch(
      () => null as any,
    );

    if (NodeSDK && getNodeAutoInstrumentations && OTLPTraceExporter) {
      const sdk = new NodeSDK({
        serviceName: process.env.OTEL_SERVICE_NAME || "heliobond-backend",
        traceExporter: new OTLPTraceExporter({
          url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
        }),
        instrumentations: [getNodeAutoInstrumentations()],
      });

      await sdk.start();
      logger.info("OpenTelemetry APM initialized");

      process.on("SIGTERM", () => {
        sdk.shutdown().catch(() => {});
      });
    } else {
      logger.warn("OpenTelemetry packages not installed, APM disabled");
    }
  } catch (err: any) {
    logger.error("Failed to initialize OpenTelemetry APM", { error: err?.message });
  }
}
