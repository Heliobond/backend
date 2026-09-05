import { computeScores, type IotInput } from "../lib/scoring";
import { updateImpactScore } from "../lib/registry";
import { getSolarData, getSatelliteData } from "../routes/iot";

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("../lib/registry", () => ({
  updateImpactScore: jest.fn(),
}));

jest.mock("../lib/stellar", () => ({
  withRpcConnection: jest.fn().mockImplementation((fn: (client: any) => Promise<any>) =>
    fn({
      getAccount: jest.fn().mockResolvedValue({ id: "GABCDEF", sequenceNumber: "1" }),
      prepareTransaction: jest.fn().mockImplementation((tx: any) => tx),
    }),
  ),
  getAdminKeypair: jest.fn().mockReturnValue({
    publicKey: () => "GABCDEF",
  }),
  networkPassphrase: "Test SDF Network ; September 2015",
  signAndSubmit: jest.fn().mockResolvedValue("tx-hash-12345"),
}));

jest.mock("../config", () => ({
  config: {
    PROJECT_REGISTRY_CONTRACT_ID: "CCJZK7QYZ7C3X5K6J7Q7Z7X7K7J7Q7Z7X7K7J7Q7",
    ADMIN_SECRET_KEY: "SABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    STELLAR_NETWORK: "testnet",
    RPC_URL: "https://soroban-testnet.stellar.org",
    DB_POOL_MIN: 2,
    DB_POOL_MAX: 10,
    DB_POOL_ACQUIRE_TIMEOUT_MS: 5000,
    DB_POOL_HEALTH_CHECK_INTERVAL_MS: 30000,
    RPC_BREAKER_FAILURE_THRESHOLD: 5,
    RPC_BREAKER_RECOVERY_TIMEOUT_MS: 30000,
    TX_MAX_RETRIES: 4,
    TX_RETRY_BASE_DELAY_MS: 200,
    TX_RETRY_MAX_DELAY_MS: 10000,
    CRON_TIMEZONE: "UTC",
    CRON_FAILURE_THRESHOLD: 0.5,
    SHUTDOWN_TIMEOUT_MS: 30000,
    LOG_LEVEL: "",
    NODE_ENV: "test",
    PORT: 3001,
    FRONTEND_URL: "http://localhost:3000",
    ADMIN_API_KEY: "",
    WS_AUTH_TOKEN: "",
    RATE_LIMIT_WINDOW_MS: 60000,
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_ADMIN_WINDOW_MS: 60000,
    MAX_POWER_KW: 1000,
    RATE_LIMIT_ADMIN_MAX: 20,
    ADMIN_IP_WHITELIST: "",
    ADMIN_IP_WHITELIST_BYPASS_PRIVATE: "true",
    REQUEST_SIGNING_SECRET: "",
    APM_PROVIDER: "none",
    CORS_ORIGINS: "",
    SECRETS_PROVIDER: "env",
  },
}));

jest.mock("../lib/satellite-sources", () => ({
  fetchSatelliteWithFallback: jest.fn().mockResolvedValue({
    forest_density_pct: 75,
    ndvi_score: 0.75,
    timestamp: Date.now(),
  }),
}));

jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockedUpdateImpactScore = updateImpactScore as jest.Mock;

describe("Integration: IoT data → scoring → Stellar submission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("complete scoring workflow for one project", async () => {
    const projectId = 42;

    // Step 1: Fetch IoT data (solar + satellite)
    const solarData = getSolarData(projectId);
    const satelliteData = getSatelliteData(projectId);

    expect(solarData).toBeDefined();
    expect(solarData.power_output_kw).toBeGreaterThan(0);
    expect(solarData.max_power_kw).toBeGreaterThan(0);
    expect(solarData.efficiency_pct).toBeGreaterThan(0);
    expect(satelliteData).toBeDefined();
    expect(satelliteData.forest_density_pct).toBeGreaterThan(0);

    // Step 2: Compute scores
    const input: IotInput = {
      solar: {
        efficiency_pct: solarData.efficiency_pct,
        power_output_kw: solarData.power_output_kw,
        max_power_kw: solarData.max_power_kw,
      },
      satellite: {
        forest_density_pct: satelliteData.forest_density_pct,
        ndvi_score: satelliteData.ndvi_score,
      },
    };

    const scores = computeScores(input);

    expect(scores).toBeDefined();
    expect(scores.credit_quality).toBeGreaterThanOrEqual(0);
    expect(scores.credit_quality).toBeLessThanOrEqual(100);
    expect(scores.green_impact).toBeGreaterThanOrEqual(0);
    expect(scores.green_impact).toBeLessThanOrEqual(100);

    // Step 3: Submit to contract via registry
    mockedUpdateImpactScore.mockResolvedValue("tx-hash-abc123");
    const txHash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact);

    expect(txHash).toBe("tx-hash-abc123");
    expect(mockedUpdateImpactScore).toHaveBeenCalledWith(
      projectId,
      scores.credit_quality,
      scores.green_impact,
    );
  });

  it("correct XDR is generated with expected score values", async () => {
    const projectId = 7;
    const creditQuality = 85;
    const greenImpact = 72;

    mockedUpdateImpactScore.mockResolvedValue("tx-hash-xdr-789");
    const txHash = await updateImpactScore(projectId, creditQuality, greenImpact);

    expect(txHash).toBe("tx-hash-xdr-789");
    expect(mockedUpdateImpactScore).toHaveBeenCalledWith(projectId, creditQuality, greenImpact);
  });

  it("score values match expected for known inputs", () => {
    // Known input → expected output
    const input: IotInput = {
      solar: { efficiency_pct: 80, power_output_kw: 800, max_power_kw: 1000 },
      satellite: { forest_density_pct: 60, ndvi_score: 0.6 },
    };

    const scores = computeScores(input);

    // (800/1000)*50 + (60/100)*50 = 40 + 30 = 70
    expect(scores.green_impact).toBe(70);
    expect(scores.credit_quality).toBe(80);
  });
});
