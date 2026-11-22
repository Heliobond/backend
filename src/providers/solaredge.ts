import { SolarDataProvider, SolarReading, ProjectCredentials } from "./types";
import { createHash } from "crypto";
import { logger } from "../lib/logger";

/**
 * SolarEdge Monitoring API integration.
 * Issue #653: Real solar inverter data provider.
 *
 * API Docs: https://www.solaredge.com/sites/default/files/se_monitoring_api.pdf
 *
 * Required credentials:
 * - api_key: SolarEdge API key
 * - metadata.site_id: SolarEdge site identifier
 */
export class SolarEdgeProvider implements SolarDataProvider {
  readonly name = "solaredge";
  readonly priority = 1; // Highest priority
  enabled = true;

  private readonly baseUrl = "https://monitoringapi.solaredge.com";

  async fetch(projectId: number, credentials?: ProjectCredentials): Promise<SolarReading> {
    if (!credentials?.metadata?.site_id) {
      throw new Error("SolarEdge provider requires site_id in credentials metadata");
    }

    const siteId = credentials.metadata.site_id as string;
    const apiKey = credentials.api_key;

    // Fetch current power and overview
    const [powerData, overviewData] = await Promise.all([
      this.fetchCurrentPower(siteId, apiKey),
      this.fetchSiteOverview(siteId, apiKey),
    ]);

    const rawPayload = { powerData, overviewData, fetched_at: Date.now() };

    // Extract metrics
    const power_output_kw = (powerData.power ?? 0) / 1000; // Convert W to kW
    const max_power_kw = (overviewData.peakPower ?? 0) / 1000;
    const efficiency_pct =
      max_power_kw > 0 ? Math.min(100, (power_output_kw / max_power_kw) * 100) : 0;

    return {
      power_output_kw: Math.round(power_output_kw * 100) / 100,
      efficiency_pct: Math.round(efficiency_pct * 100) / 100,
      max_power_kw: Math.round(max_power_kw * 100) / 100,
      timestamp: Date.now(),
      provenance: {
        source: this.name,
        fetched_at: Date.now(),
        payload_hash: createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex"),
        external_ref: siteId,
      },
    };
  }

  private async fetchCurrentPower(siteId: string, apiKey: string): Promise<any> {
    const url = `${this.baseUrl}/site/${siteId}/currentPowerFlow.json?api_key=${apiKey}`;

    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`SolarEdge API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      siteCurrentPowerFlow?: { PV?: { currentPower?: number }; unit?: string };
    };
    logger.debug("[solaredge] Fetched current power", {
      siteId,
      power: data.siteCurrentPowerFlow?.PV?.currentPower,
    });

    return {
      power: data.siteCurrentPowerFlow?.PV?.currentPower ?? 0,
      unit: data.siteCurrentPowerFlow?.unit ?? "W",
    };
  }

  private async fetchSiteOverview(siteId: string, apiKey: string): Promise<any> {
    const url = `${this.baseUrl}/site/${siteId}/overview.json?api_key=${apiKey}`;

    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`SolarEdge API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      overview?: { peakPower?: number; installationDate?: string };
    };
    logger.debug("[solaredge] Fetched site overview", {
      siteId,
      peakPower: data.overview?.peakPower,
    });

    return {
      peakPower: data.overview?.peakPower ?? 0,
      installationDate: data.overview?.installationDate,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/version/current`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch (error) {
      logger.error("[solaredge] Health check failed", { error });
      return false;
    }
  }
}
