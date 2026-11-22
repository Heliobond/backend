import { SolarDataProvider, SolarReading, SatelliteDataProvider, SatelliteReading } from "./types";
import { createHash } from "crypto";

const MAX_POWER_KW = parseInt(process.env.MAX_POWER_KW ?? "1000", 10);

/**
 * Seeded random number generator for consistent simulations.
 * Same implementation as src/lib/iot.ts for backwards compatibility.
 */
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getHourSeed(): number {
  return Math.floor(Date.now() / (1000 * 60 * 60));
}

function hashPayload(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

/**
 * Simulator solar provider - maintains existing seededRandom behavior.
 * Used as default fallback for dev/testnet environments.
 */
export class SimulatorSolarProvider implements SolarDataProvider {
  readonly name = "simulator";
  readonly priority = 100; // Lowest priority (fallback)
  enabled = true;

  async fetch(projectId: number): Promise<SolarReading> {
    const base = seededRandom(projectId);
    const drift = seededRandom(projectId * 7 + 1);

    const efficiency_pct = Math.min(98, Math.max(40, 40 + base * 58 + drift * 2 - 1));
    const power_output_kw = (efficiency_pct / 100) * MAX_POWER_KW;

    const reading = {
      power_output_kw: Math.round(power_output_kw * 100) / 100,
      efficiency_pct: Math.round(efficiency_pct * 100) / 100,
      max_power_kw: MAX_POWER_KW,
      timestamp: Date.now(),
    };

    return {
      ...reading,
      provenance: {
        source: this.name,
        fetched_at: Date.now(),
        payload_hash: hashPayload({ projectId, hourSeed: getHourSeed(), reading }),
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/**
 * Simulator satellite provider - maintains existing seededRandom behavior.
 */
export class SimulatorSatelliteProvider implements SatelliteDataProvider {
  readonly name = "simulator";
  readonly priority = 100;
  enabled = true;

  async fetch(projectId: number): Promise<SatelliteReading> {
    const base = seededRandom(projectId * 3 + 5);
    const drift = seededRandom(projectId * 11 + 2);

    const forest_density_pct = Math.min(100, Math.max(0, 30 + base * 65 + drift * 5 - 2.5));

    const reading = {
      forest_density_pct: Math.round(forest_density_pct * 100) / 100,
      ndvi_score: Math.round(Math.min(1, forest_density_pct / 100) * 1000) / 1000,
      timestamp: Date.now(),
    };

    return {
      ...reading,
      provenance: {
        source: this.name,
        fetched_at: Date.now(),
        payload_hash: hashPayload({ projectId, hourSeed: getHourSeed(), reading }),
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
