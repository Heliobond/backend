import { logger } from "../logger";

/**
 * Minimum update interval enforced by the ProjectRegistry contract (in seconds).
 * Matches MIN_UPDATE_INTERVAL in contracts/project_registry/src/lib.rs:61
 */
export const MIN_UPDATE_INTERVAL = 3600; // 3600 seconds = 1 hour

/**
 * Safety margin to avoid racing with the 3600s interval (in seconds).
 * Adding a margin ensures we don't submit updates slightly before the interval expires.
 *
 * Issue #644: The cron runs at :00, but ledger close times vary by a few seconds.
 * This margin prevents submissions that would land 1-2 seconds before 3600s elapsed.
 */
export const UPDATE_SAFETY_MARGIN = 30; // 30 seconds margin

/**
 * Contract error codes from ProjectRegistry
 */
export enum ProjectRegistryError {
  UpdateTooFrequent = "UpdateTooFrequent",
}

/**
 * Project data returned from get_project
 */
export interface ProjectData {
  id: string;
  name: string;
  impact_score: number;
  last_update_timestamp: number; // Unix timestamp in seconds
}

/**
 * Result of an update attempt
 */
export interface UpdateResult {
  success: boolean;
  skipped: boolean;
  reason?: string;
  transactionHash?: string;
  lastUpdateTimestamp?: number;
}

/**
 * Service for interacting with the ProjectRegistry Soroban contract.
 *
 * This service prevents UpdateTooFrequent errors by checking last_update_timestamp
 * before submitting score updates to the registry contract.
 */
export class ProjectRegistryService {
  private contractId: string;

  constructor(contractId?: string) {
    this.contractId = contractId || process.env.PROJECT_REGISTRY_CONTRACT_ID || "";

    if (!this.contractId) {
      logger.warn(
        "[project-registry] PROJECT_REGISTRY_CONTRACT_ID not configured - oracle updates disabled",
      );
    }
  }

  /**
   * Get project data from the contract, including last_update_timestamp.
   *
   * In production, this would invoke the get_project Soroban contract function.
   * The contract returns the project struct which includes last_update_timestamp.
   */
  async getProject(projectId: string): Promise<ProjectData> {
    try {
      logger.debug(`[project-registry] Fetching project data for: ${projectId}`);

      // TODO: Implement actual Soroban contract invocation
      // This requires the Stellar SDK's Soroban support:
      // const contract = new SorobanClient.Contract(this.contractId);
      // const result = await contract.call('get_project', xdr.scvU32(projectId));
      // return parseProjectData(result);

      throw new Error(
        "Soroban contract invocation not implemented - requires @stellar/stellar-sdk Soroban support",
      );
    } catch (error: any) {
      logger.error(`[project-registry] Failed to fetch project ${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Check if enough time has passed since the last update.
   * Returns true if an update can be submitted, false if it should be skipped.
   *
   * Issue #644: This prevents submitting updates when fewer than 3600s + margin have elapsed.
   */
  canUpdateProject(lastUpdateTimestamp: number): {
    canUpdate: boolean;
    reason?: string;
    waitSeconds?: number;
  } {
    const now = Math.floor(Date.now() / 1000); // Current time in seconds
    const timeSinceLastUpdate = now - lastUpdateTimestamp;
    const requiredInterval = MIN_UPDATE_INTERVAL + UPDATE_SAFETY_MARGIN;

    if (timeSinceLastUpdate < requiredInterval) {
      const waitSeconds = requiredInterval - timeSinceLastUpdate;
      logger.info(
        `[project-registry] Update too frequent. Last update: ${lastUpdateTimestamp}, ` +
          `time since: ${timeSinceLastUpdate}s, required: ${requiredInterval}s, ` +
          `wait: ${waitSeconds}s`,
      );
      return {
        canUpdate: false,
        reason: `Update too frequent. Need to wait ${waitSeconds} more seconds (${Math.ceil(waitSeconds / 60)} minutes)`,
        waitSeconds,
      };
    }

    logger.debug(
      `[project-registry] Update allowed. Time since last update: ${timeSinceLastUpdate}s ` +
        `(required: ${requiredInterval}s = ${MIN_UPDATE_INTERVAL}s + ${UPDATE_SAFETY_MARGIN}s margin)`,
    );
    return { canUpdate: true };
  }

  /**
   * Submit an impact score update to the ProjectRegistry contract.
   * Includes timestamp checking to avoid UpdateTooFrequent errors.
   *
   * Issue #644: This is the main fix - we check timestamps BEFORE submitting,
   * preventing failed transactions that waste fees.
   */
  async updateImpactScore(
    projectId: string,
    impactScore: number,
    skipTimestampCheck: boolean = false,
  ): Promise<UpdateResult> {
    try {
      logger.info(
        `[project-registry] Attempting to update impact score for project ${projectId} to ${impactScore}`,
      );

      // Step 1: Read last_update_timestamp from get_project (#644 fix)
      if (!skipTimestampCheck) {
        let projectData: ProjectData;
        try {
          projectData = await this.getProject(projectId);
        } catch (error: any) {
          logger.warn(
            `[project-registry] Could not fetch project data for timestamp check: ${error.message}`,
          );
          return {
            success: false,
            skipped: true,
            reason: `Failed to fetch project data: ${error.message}`,
          };
        }

        // Step 2: Check if enough time has passed (#644 fix)
        const updateCheck = this.canUpdateProject(projectData.last_update_timestamp);
        if (!updateCheck.canUpdate) {
          logger.info(
            `[project-registry] Skipping update for project ${projectId}: ${updateCheck.reason}`,
          );
          return {
            success: true, // This is a successful skip, not a failure
            skipped: true,
            reason: updateCheck.reason,
            lastUpdateTimestamp: projectData.last_update_timestamp,
          };
        }
      }

      // Step 3: Submit the update transaction
      logger.info(`[project-registry] Submitting impact score update for project ${projectId}`);

      // TODO: Implement actual Soroban transaction submission

      throw new Error(
        "Soroban contract transaction not implemented - requires @stellar/stellar-sdk Soroban support",
      );
    } catch (error: any) {
      // Step 4: Map UpdateTooFrequent contract error to non-alerting skip (#644 fix)
      if (this.isUpdateTooFrequentError(error)) {
        logger.info(
          `[project-registry] Received UpdateTooFrequent error for project ${projectId} - ` +
            `treating as skipped (non-alerting). This should be rare with timestamp checking.`,
        );
        return {
          success: true,
          skipped: true,
          reason: "Contract returned UpdateTooFrequent error",
        };
      }

      logger.error(
        `[project-registry] Failed to update impact score for project ${projectId}:`,
        error,
      );
      return {
        success: false,
        skipped: false,
        reason: `Update failed: ${error.message}`,
      };
    }
  }

  /**
   * Check if an error is the UpdateTooFrequent contract error.
   */
  private isUpdateTooFrequentError(error: any): boolean {
    if (error.message && error.message.includes("UpdateTooFrequent")) return true;
    if (error.code === ProjectRegistryError.UpdateTooFrequent) return true;
    if (error.contractError === "UpdateTooFrequent") return true;
    if (error.data?.error === "UpdateTooFrequent") return true;
    return false;
  }
}

let projectRegistryService: ProjectRegistryService | null = null;

export function getProjectRegistryService(): ProjectRegistryService {
  if (!projectRegistryService) {
    projectRegistryService = new ProjectRegistryService();
  }
  return projectRegistryService;
}

export function resetProjectRegistryService(): void {
  projectRegistryService = null;
}
