import {
  SolarDataProvider,
  SatelliteDataProvider,
  SolarReading,
  SatelliteReading,
  ProviderHealth,
  ProjectCredentials,
} from "./types";
import { SimulatorSolarProvider, SimulatorSatelliteProvider } from "./simulator";
import { SolarEdgeProvider } from "./solaredge";
import { logger } from "../lib/logger";

/**
 * Provider registry for solar and satellite data.
 * Issue #653: Pluggable provider architecture with fallback support.
 */

const solarProviders: SolarDataProvider[] = [
  new SolarEdgeProvider(),
  new SimulatorSolarProvider(), // Always available as fallback
];

const satelliteProviders: SatelliteDataProvider[] = [
  new SimulatorSatelliteProvider(), // Only simulator for now (Sentinel-2 can be added)
];

const healthMap = new Map<string, ProviderHealth>();

function markHealthy(name: string): void {
  healthMap.set(name, {
    name,
    healthy: true,
    last_checked: Date.now(),
    failure_count: 0,
  });
}

function markUnhealthy(name: string, error: string): void {
  const existing = healthMap.get(name);
  healthMap.set(name, {
    name,
    healthy: false,
    last_checked: Date.now(),
    failure_count: (existing?.failure_count ?? 0) + 1,
    last_error: error,
  });
}

/**
 * Fetch solar data with provider fallback.
 * Tries providers in priority order (lower priority number = tried first).
 * Falls back to simulator if all real providers fail.
 */
export async function fetchSolarData(
  projectId: number,
  credentials?: ProjectCredentials,
): Promise<SolarReading> {
  const enabled = solarProviders.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority);

  for (const provider of enabled) {
    try {
      logger.debug(`[solar-registry] Trying provider ${provider.name}`, { projectId });
      const reading = await provider.fetch(projectId, credentials);
      markHealthy(provider.name);
      logger.info(`[solar-registry] Success with ${provider.name}`, {
        projectId,
        source: reading.provenance.source,
      });
      return reading;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      markUnhealthy(provider.name, msg);
      logger.warn(`[solar-registry] Provider ${provider.name} failed`, { projectId, error: msg });
    }
  }

  throw new Error("All solar providers failed");
}

/**
 * Fetch satellite data with provider fallback.
 */
export async function fetchSatelliteData(
  projectId: number,
  polygon?: [number, number][],
  credentials?: ProjectCredentials,
): Promise<SatelliteReading> {
  const enabled = satelliteProviders
    .filter((p) => p.enabled)
    .sort((a, b) => a.priority - b.priority);

  for (const provider of enabled) {
    try {
      logger.debug(`[satellite-registry] Trying provider ${provider.name}`, { projectId });
      const reading = await provider.fetch(projectId, polygon, credentials);
      markHealthy(provider.name);
      logger.info(`[satellite-registry] Success with ${provider.name}`, {
        projectId,
        source: reading.provenance.source,
      });
      return reading;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      markUnhealthy(provider.name, msg);
      logger.warn(`[satellite-registry] Provider ${provider.name} failed`, {
        projectId,
        error: msg,
      });
    }
  }

  throw new Error("All satellite providers failed");
}

export function getProviderHealth(): { solar: ProviderHealth[]; satellite: ProviderHealth[] } {
  return {
    solar: solarProviders.map(
      (p) =>
        healthMap.get(p.name) ?? {
          name: p.name,
          healthy: true,
          last_checked: 0,
          failure_count: 0,
        },
    ),
    satellite: satelliteProviders.map(
      (p) =>
        healthMap.get(p.name) ?? {
          name: p.name,
          healthy: true,
          last_checked: 0,
          failure_count: 0,
        },
    ),
  };
}

export function getSolarProviders(): SolarDataProvider[] {
  return [...solarProviders];
}

export function getSatelliteProviders(): SatelliteDataProvider[] {
  return [...satelliteProviders];
}
