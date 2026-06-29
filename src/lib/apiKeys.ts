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
}

// In-memory store for API keys
const keysStore = new Map<string, ApiKey>();

// In-memory rate limiting tracks: keyId -> { currentMinute, count }
const rateLimitMap = new Map<string, { currentMinute: number; count: number }>();

export function generateApiKey(consumerName: string, rateLimit = 100): ApiKey {
  const id = crypto.randomUUID();
  const key = `hk_live_${crypto.randomBytes(24).toString("hex")}`;
  const apiKey: ApiKey = {
    id,
    key,
    consumer_name: consumerName,
    status: "active",
    rate_limit: rateLimit,
    usage_count: 0,
    last_used_at: null,
    created_at: Date.now(),
  };
  keysStore.set(id, apiKey);
  return apiKey;
}

export function rotateApiKey(id: string): ApiKey | null {
  const apiKey = keysStore.get(id);
  if (!apiKey || apiKey.status === "revoked") return null;

  const newKey = `hk_live_${crypto.randomBytes(24).toString("hex")}`;
  apiKey.key = newKey;
  keysStore.set(id, apiKey);
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
  for (const apiKey of keysStore.values()) {
    if (apiKey.key === key && apiKey.status === "active") {
      return apiKey;
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
