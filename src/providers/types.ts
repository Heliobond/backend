/**
 * Pluggable data provider interfaces for solar and satellite data.
 * Issue #653: Replace seededRandom simulations with real data sources.
 */

/** Provenance metadata tracked with every data reading */
export interface DataProvenance {
  source: string;
  fetched_at: number;
  payload_hash: string;
  external_ref?: string;
}

/** Solar panel inverter data reading with provenance */
export interface SolarReading {
  power_output_kw: number;
  efficiency_pct: number;
  max_power_kw: number;
  timestamp: number;
  provenance: DataProvenance;
}

/** Satellite NDVI/vegetation data reading with provenance */
export interface SatelliteReading {
  forest_density_pct: number;
  ndvi_score: number;
  timestamp: number;
  provenance: DataProvenance;
}

/** Per-project credentials for external APIs */
export interface ProjectCredentials {
  project_id: number;
  api_key: string;
  api_secret?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Solar data provider interface.
 * Implementations fetch real-time solar data from inverter APIs or simulators.
 */
export interface SolarDataProvider {
  readonly name: string;
  readonly priority: number;
  enabled: boolean;
  fetch(projectId: number, credentials?: ProjectCredentials): Promise<SolarReading>;
  healthCheck?(): Promise<boolean>;
}

/**
 * Satellite data provider interface.
 * Implementations fetch vegetation indices from satellite APIs or simulators.
 */
export interface SatelliteDataProvider {
  readonly name: string;
  readonly priority: number;
  enabled: boolean;
  fetch(
    projectId: number,
    polygon?: [number, number][],
    credentials?: ProjectCredentials
  ): Promise<SatelliteReading>;
  healthCheck?(): Promise<boolean>;
}

/** Provider health status */
export interface ProviderHealth {
  name: string;
  healthy: boolean;
  last_checked: number;
  failure_count: number;
  last_error?: string;
}
