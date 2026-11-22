jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { logger } from "../lib/logger";
import {
  cacheClear,
  fetchSatelliteWithFallback,
  getOutageState,
  getSources,
  registerSource,
} from "../lib/satellite-sources";

const ALERT_MESSAGE = "[satellite] ALERT: extended satellite data outage";
const RECOVERY_MESSAGE = "[satellite] satellite data sources recovered";
const HOUR_MS = 3_600_000;

const flaky = { failing: true };
registerSource({
  name: "test-flaky",
  priority: 0,
  enabled: true,
  async fetch() {
    if (flaky.failing) throw new Error("offline");
    return { forest_density_pct: 70, ndvi_score: 0.7, timestamp: Date.now(), source: "test-flaky" };
  },
});

function alertCalls(): unknown[][] {
  return (logger.error as jest.Mock).mock.calls.filter(([msg]) => msg === ALERT_MESSAGE);
}

function recoveryCalls(): unknown[][] {
  return (logger.info as jest.Mock).mock.calls.filter(([msg]) => msg === RECOVERY_MESSAGE);
}

describe("satellite outage alert rate limiting", () => {
  let now: number;
  const builtins = getSources().filter((s) => s.name !== "test-flaky");

  beforeAll(() => {
    builtins.forEach((s) => (s.enabled = false));
  });

  afterAll(() => {
    builtins.forEach((s) => (s.enabled = true));
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    now = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    // Start every test from a recovered state.
    flaky.failing = false;
    await fetchSatelliteWithFallback(1);
    flaky.failing = true;
    cacheClear();
    jest.clearAllMocks();
  });

  it("emits one initial alert for a sustained outage, not one per fetch", async () => {
    for (let projectId = 1; projectId <= 20; projectId++) {
      await fetchSatelliteWithFallback(projectId);
    }

    expect(getOutageState().consecutiveFailures).toBe(20);
    expect(alertCalls()).toHaveLength(1);
    expect(alertCalls()[0][1]).toMatchObject({ consecutiveFailures: 3, reminder: false });
  });

  it("emits bounded reminders once the reminder interval elapses", async () => {
    for (let i = 0; i < 5; i++) await fetchSatelliteWithFallback(1);
    expect(alertCalls()).toHaveLength(1);

    now += HOUR_MS - 1;
    await fetchSatelliteWithFallback(1);
    expect(alertCalls()).toHaveLength(1);

    now += 1;
    await fetchSatelliteWithFallback(1);
    await fetchSatelliteWithFallback(1);
    expect(alertCalls()).toHaveLength(2);
    expect(alertCalls()[1][1]).toMatchObject({ reminder: true });
  });

  it("logs recovery once and alerts again for a later distinct outage", async () => {
    for (let i = 0; i < 4; i++) await fetchSatelliteWithFallback(1);
    expect(alertCalls()).toHaveLength(1);

    flaky.failing = false;
    await fetchSatelliteWithFallback(1);
    await fetchSatelliteWithFallback(1);
    expect(recoveryCalls()).toHaveLength(1);
    expect(getOutageState().lastAlertAt).toBeNull();

    flaky.failing = true;
    for (let i = 0; i < 4; i++) await fetchSatelliteWithFallback(1);
    expect(alertCalls()).toHaveLength(2);
    expect(alertCalls()[1][1]).toMatchObject({ reminder: false });
  });
});
