/**
 * Solar panel configuration store (#25).
 *
 * Holds per-project panel specifications — type, efficiency, capacity,
 * orientation/tilt and shading — in an in-memory map. Mirrors the lightweight
 * store pattern used by `history` and `webhooks`.
 */

export type PanelType = "monocrystalline" | "polycrystalline" | "thin-film" | "bifacial";

export type Orientation = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

const PANEL_TYPES: readonly PanelType[] = [
  "monocrystalline",
  "polycrystalline",
  "thin-film",
  "bifacial",
];

const ORIENTATIONS: readonly Orientation[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export interface PanelConfig {
  project_id: number;
  panel_type: PanelType;
  /** Module efficiency rating as a percentage (0–100). */
  efficiency_rating: number;
  /** Installed DC capacity in kilowatts. */
  capacity_kw: number;
  orientation: Orientation;
  /** Tilt angle from horizontal, in degrees (0–90). */
  tilt_angle: number;
  /** Fraction of output lost to shading (0–1). */
  shading_factor: number;
  updated_at: string;
}

export interface PanelConfigInput {
  panel_type?: unknown;
  efficiency_rating?: unknown;
  capacity_kw?: unknown;
  orientation?: unknown;
  tilt_angle?: unknown;
  shading_factor?: unknown;
}

export class PanelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelValidationError";
  }
}

const store = new Map<number, PanelConfig>();

/**
 * Validate a raw panel configuration payload, returning a normalised object.
 * Throws `PanelValidationError` on the first problem encountered.
 */
export function validatePanelConfig(input: PanelConfigInput): Omit<PanelConfig, "project_id" | "updated_at"> {
  const { panel_type, efficiency_rating, capacity_kw, orientation, tilt_angle, shading_factor } = input;

  if (typeof panel_type !== "string" || !PANEL_TYPES.includes(panel_type as PanelType)) {
    throw new PanelValidationError(`panel_type must be one of: ${PANEL_TYPES.join(", ")}`);
  }
  if (typeof efficiency_rating !== "number" || efficiency_rating <= 0 || efficiency_rating > 100) {
    throw new PanelValidationError("efficiency_rating must be a number in (0, 100]");
  }
  if (typeof capacity_kw !== "number" || capacity_kw <= 0) {
    throw new PanelValidationError("capacity_kw must be a positive number");
  }
  if (typeof orientation !== "string" || !ORIENTATIONS.includes(orientation as Orientation)) {
    throw new PanelValidationError(`orientation must be one of: ${ORIENTATIONS.join(", ")}`);
  }
  if (typeof tilt_angle !== "number" || tilt_angle < 0 || tilt_angle > 90) {
    throw new PanelValidationError("tilt_angle must be a number between 0 and 90 degrees");
  }
  if (typeof shading_factor !== "number" || shading_factor < 0 || shading_factor > 1) {
    throw new PanelValidationError("shading_factor must be a number between 0 and 1");
  }

  return {
    panel_type: panel_type as PanelType,
    efficiency_rating,
    capacity_kw,
    orientation: orientation as Orientation,
    tilt_angle,
    shading_factor,
  };
}

/** Replace (or create) the full panel configuration for a project. */
export function setPanelConfig(projectId: number, input: PanelConfigInput): PanelConfig {
  const validated = validatePanelConfig(input);
  const config: PanelConfig = { project_id: projectId, ...validated, updated_at: new Date().toISOString() };
  store.set(projectId, config);
  return config;
}

/** Apply a partial update on top of an existing configuration. */
export function updatePanelConfig(projectId: number, patch: PanelConfigInput): PanelConfig {
  const existing = store.get(projectId);
  if (!existing) {
    throw new PanelValidationError("no panel configuration exists for this project");
  }
  // Merge then re-validate so partial updates can't produce an invalid config.
  const merged: PanelConfigInput = {
    panel_type: patch.panel_type ?? existing.panel_type,
    efficiency_rating: patch.efficiency_rating ?? existing.efficiency_rating,
    capacity_kw: patch.capacity_kw ?? existing.capacity_kw,
    orientation: patch.orientation ?? existing.orientation,
    tilt_angle: patch.tilt_angle ?? existing.tilt_angle,
    shading_factor: patch.shading_factor ?? existing.shading_factor,
  };
  return setPanelConfig(projectId, merged);
}

export function getPanelConfig(projectId: number): PanelConfig | undefined {
  return store.get(projectId);
}

export function listPanelConfigs(): PanelConfig[] {
  return Array.from(store.values());
}

/** Effective capacity after applying the shading loss factor. */
export function effectiveCapacityKw(config: PanelConfig): number {
  return Math.round(config.capacity_kw * (1 - config.shading_factor) * 100) / 100;
}
