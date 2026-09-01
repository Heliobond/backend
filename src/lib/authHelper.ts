import { validateApiKey, isRateLimited, incrementUsage } from "./apiKeys";
import { timingSafeCompare } from "./timing-safe";

export interface AuthContext {
  providedKey: string;
  isAdmin: boolean;
  isConsumer: boolean;
  consumerName?: string;
  apiKeyId?: string;
  rateLimit?: number;
  error?: "missing" | "invalid" | "rate_limited";
}

export function resolveAuthFromHeaders(headers: {
  authorization?: string;
  "x-api-key"?: string | string[];
  [key: string]: string | string[] | undefined;
}): AuthContext {
  const authHeader = headers.authorization;
  const apiKeyHeader = headers["x-api-key"];
  let providedKey = "";

  if (apiKeyHeader && typeof apiKeyHeader === "string") {
    providedKey = apiKeyHeader;
  } else if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.substring(7);
  }

  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && timingSafeCompare(providedKey, adminKey)) {
    return { providedKey, isAdmin: true, isConsumer: false };
  }

  if (!providedKey) {
    return { providedKey, isAdmin: false, isConsumer: false, error: "missing" };
  }

  const apiKeyRecord = validateApiKey(providedKey);
  if (!apiKeyRecord) {
    return { providedKey, isAdmin: false, isConsumer: false, error: "invalid" };
  }

  if (isRateLimited(apiKeyRecord.id, apiKeyRecord.rate_limit)) {
    return { providedKey, isAdmin: false, isConsumer: false, error: "rate_limited" };
  }

  incrementUsage(apiKeyRecord.id);

  return {
    providedKey,
    isAdmin: false,
    isConsumer: true,
    consumerName: apiKeyRecord.consumer_name,
    apiKeyId: apiKeyRecord.id,
    rateLimit: apiKeyRecord.rate_limit,
  };
}
