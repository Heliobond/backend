import crypto from "crypto";

export interface ApiKey {
  id: string;
  key: string;
  consumer_name: string;
  status: "active" | "revoked";
  rate_limit: number; // requests per minute
  usage_count: number;
  last_used_at: number | null;
  created_at: number;
  rotation_interval_days?: number;
  next_rotation_at?: number;
  old_key?: string;
  new_key_expires_at?: number;
  last_rotated_at?: number;
}

export interface RotationNotification {
  key_id: string;
  consumer_name: string;
  rotated_at: number;
  old_key_expires_at: number;
}

// In-memory store for API keys
const keysStore = new Map<string, ApiKey>();

// In-memory rate limiting tracks: keyId -> { currentMinute, count }
const rateLimitMap = new Map<string, { currentMinute: number; count: number }>();

// Rotation notification callbacks
const rotationCallbacks: Array<(notification: RotationNotification) => void> = [];

export function onRotation(callback: (notification: RotationNotification) => void): void {
  rotationCallbacks.push(callback);
}

function emitRotationNotification(notification: RotationNotification): void {
  for (const callback of rotationCallbacks) {
    try {
      callback(notification);
    } catch {
      // Ignore callback errors
    }
  }
}

export function generateApiKey(
  consumerName: string,
  rateLimit = 100,
  rotationIntervalDays?: number,
): ApiKey {
  const id = crypto.randomUUID();
  const key = `hk_live_${crypto.randomBytes(24).toString("hex")}`;
  const now = Date.now();
  const apiKey: ApiKey = {
    id,
    key,
    consumer_name: consumerName,
    status: "active",
    rate_limit: rateLimit,
    usage_count: 0,
    last_used_at: null,
    created_at: now,
  };

  if (rotationIntervalDays && rotationIntervalDays > 0) {
    apiKey.rotation_interval_days = rotationIntervalDays;
    apiKey.next_rotation_at = now + rotationIntervalDays * 24 * 60 * 60 * 1000;
  }

  keysStore.set(id, apiKey);
  return apiKey;
}

export function rotateApiKey(id: string, gracePeriodMs?: number): ApiKey | null {
  const apiKey = keysStore.get(id);
  if (!apiKey || apiKey.status === "revoked") return null;

  const newKey = `hk_live_${crypto.randomBytes(24).toString("hex")}`;
  const now = Date.now();

  // Store old key for grace period if specified
  if (gracePeriodMs && gracePeriodMs > 0) {
    apiKey.old_key = apiKey.key;
    apiKey.new_key_expires_at = now + gracePeriodMs;
  }

  apiKey.key = newKey;
  apiKey.last_rotated_at = now;

  if (apiKey.rotation_interval_days) {
    apiKey.next_rotation_at = now + apiKey.rotation_interval_days * 24 * 60 * 60 * 1000;
  }

  keysStore.set(id, apiKey);

  emitRotationNotification({
    key_id: id,
    consumer_name: apiKey.consumer_name,
    rotated_at: now,
    old_key_expires_at: apiKey.new_key_expires_at ?? now,
  });

  return apiKey;
}

export function revokeApiKey(id: string): boolean {
  const apiKey = keysStore.get(id);
  if (!apiKey) return false;

  apiKey.status = "revoked";
  keysStore.set(id, apiKey);
  return true;
}

export function listApiKeys(): ApiKey[] {
  return Array.from(keysStore.values());
}

export function getApiKeyDetails(id: string): ApiKey | null {
  return keysStore.get(id) || null;
}

export function validateApiKey(key: string): ApiKey | null {
  const now = Date.now();
  for (const apiKey of keysStore.values()) {
    if (apiKey.status !== "active") continue;

    // Check current key
    if (apiKey.key === key) {
      return apiKey;
    }

    // Check old key during grace period
    if (apiKey.old_key && apiKey.new_key_expires_at && now < apiKey.new_key_expires_at) {
      if (apiKey.old_key === key) {
        return apiKey;
      }
    }
  }
  return null;
}

export function incrementUsage(id: string): void {
  const apiKey = keysStore.get(id);
  if (apiKey) {
    apiKey.usage_count++;
    apiKey.last_used_at = Date.now();
    keysStore.set(id, apiKey);
  }
}

export function isRateLimited(id: string, rateLimit: number): boolean {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const track = rateLimitMap.get(id);

  if (!track || track.currentMinute !== minute) {
    rateLimitMap.set(id, { currentMinute: minute, count: 1 });
    return false;
  }

  if (track.count >= rateLimit) {
    return true;
  }

  track.count++;
  return false;
}

export function clearApiKeys(): void {
  keysStore.clear();
  rateLimitMap.clear();
}

export function checkScheduledRotations(): ApiKey[] {
  const now = Date.now();
  const rotated: ApiKey[] = [];

  for (const apiKey of keysStore.values()) {
    if (apiKey.status !== "active") continue;
    if (!apiKey.next_rotation_at) continue;
    if (now >= apiKey.next_rotation_at) {
      const result = rotateApiKey(apiKey.id);
      if (result) {
        rotated.push(result);
      }
    }
  }

  return rotated;
}

export function getRotationStatus(): {
  keys_with_scheduled_rotation: number;
  keys_pending_rotation: number;
  next_rotation_at: number | null;
} {
  const now = Date.now();
  let keysWithScheduled = 0;
  let keysPending = 0;
  let nextRotationAt: number | null = null;

  for (const apiKey of keysStore.values()) {
    if (apiKey.status !== "active") continue;
    if (!apiKey.next_rotation_at) continue;

    keysWithScheduled++;
    if (now >= apiKey.next_rotation_at) {
      keysPending++;
    } else if (nextRotationAt === null || apiKey.next_rotation_at < nextRotationAt) {
      nextRotationAt = apiKey.next_rotation_at;
    }
  }

  return {
    keys_with_scheduled_rotation: keysWithScheduled,
    keys_pending_rotation: keysPending,
    next_rotation_at: nextRotationAt,
  };
}
