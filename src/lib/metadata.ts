/**
 * Project metadata store (#24).
 *
 * Holds descriptive, non-telemetry information about a project: name,
 * description, location, installation date and arbitrary custom fields.
 * Solar panel specifications live in their own store (`lib/panels`) and are
 * surfaced alongside metadata at the route layer.
 */

export interface GeoLocation {
  /** Free-form label, e.g. "Lagos, Nigeria". */
  label: string;
  latitude?: number;
  longitude?: number;
}

export interface ProjectMetadata {
  project_id: number;
  name: string;
  description: string;
  location: GeoLocation;
  /** ISO-8601 date (YYYY-MM-DD) the installation went live. */
  installation_date: string;
  /** Arbitrary string-keyed custom fields. */
  custom: Record<string, string | number | boolean>;
  updated_at: string;
}

export interface MetadataInput {
  name?: unknown;
  description?: unknown;
  location?: unknown;
  installation_date?: unknown;
  custom?: unknown;
}

export class MetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataValidationError";
  }
}

const store = new Map<number, ProjectMetadata>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateLocation(raw: unknown): GeoLocation {
  if (typeof raw !== "object" || raw === null) {
    throw new MetadataValidationError("location must be an object with a label");
  }
  const loc = raw as Record<string, unknown>;
  if (typeof loc.label !== "string" || loc.label.trim().length === 0) {
    throw new MetadataValidationError("location.label must be a non-empty string");
  }
  const result: GeoLocation = { label: loc.label.trim() };
  if (loc.latitude !== undefined) {
    if (typeof loc.latitude !== "number" || loc.latitude < -90 || loc.latitude > 90) {
      throw new MetadataValidationError("location.latitude must be a number between -90 and 90");
    }
    result.latitude = loc.latitude;
  }
  if (loc.longitude !== undefined) {
    if (typeof loc.longitude !== "number" || loc.longitude < -180 || loc.longitude > 180) {
      throw new MetadataValidationError("location.longitude must be a number between -180 and 180");
    }
    result.longitude = loc.longitude;
  }
  return result;
}

function validateCustom(raw: unknown): Record<string, string | number | boolean> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MetadataValidationError("custom must be an object of scalar values");
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new MetadataValidationError(`custom.${key} must be a string, number or boolean`);
    }
    out[key] = value;
  }
  return out;
}

/** Validate a full metadata payload, returning a normalised object. */
export function validateMetadata(input: MetadataInput): Omit<ProjectMetadata, "project_id" | "updated_at"> {
  const { name, description, location, installation_date, custom } = input;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new MetadataValidationError("name must be a non-empty string");
  }
  if (typeof description !== "string") {
    throw new MetadataValidationError("description must be a string");
  }
  if (typeof installation_date !== "string" || !ISO_DATE.test(installation_date) || Number.isNaN(Date.parse(installation_date))) {
    throw new MetadataValidationError("installation_date must be a valid ISO date (YYYY-MM-DD)");
  }

  return {
    name: name.trim(),
    description,
    location: validateLocation(location),
    installation_date,
    custom: validateCustom(custom),
  };
}

export function setMetadata(projectId: number, input: MetadataInput): ProjectMetadata {
  const validated = validateMetadata(input);
  const meta: ProjectMetadata = { project_id: projectId, ...validated, updated_at: new Date().toISOString() };
  store.set(projectId, meta);
  return meta;
}

export function updateMetadata(projectId: number, patch: MetadataInput): ProjectMetadata {
  const existing = store.get(projectId);
  if (!existing) {
    throw new MetadataValidationError("no metadata exists for this project");
  }
  // Custom fields merge field-by-field; patched keys win. setMetadata
  // re-validates the merged result, so a bad custom value still 400s.
  const mergedCustom =
    patch.custom !== undefined && typeof patch.custom === "object" && patch.custom !== null
      ? { ...existing.custom, ...(patch.custom as Record<string, unknown>) }
      : existing.custom;

  const merged: MetadataInput = {
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    location: patch.location ?? existing.location,
    installation_date: patch.installation_date ?? existing.installation_date,
    custom: mergedCustom,
  };
  return setMetadata(projectId, merged);
}

export function getMetadata(projectId: number): ProjectMetadata | undefined {
  return store.get(projectId);
}

export function listMetadata(): ProjectMetadata[] {
  return Array.from(store.values());
}
