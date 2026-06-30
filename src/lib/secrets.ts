import { logger } from "./logger";

export type SecretsProvider = "env" | "aws" | "vault" | "azure";

interface SecretsConfig {
  provider: SecretsProvider;
  aws?: {
    region: string;
    secretId: string;
    versionId?: string;
  };
  vault?: {
    endpoint: string;
    token: string;
    secretPath: string;
  };
  azure?: {
    vaultUrl: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
  rotation?: {
    enabled: boolean;
    intervalMs: number;
  };
}

interface SecretsCache {
  secrets: Map<string, string>;
  lastRotated: number;
}

const cache: SecretsCache = {
  secrets: new Map(),
  lastRotated: Date.now(),
};

function getConfig(): SecretsConfig {
  const provider = (process.env.SECRETS_PROVIDER || "env") as SecretsProvider;
  return {
    provider,
    aws: {
      region: process.env.AWS_REGION || "us-east-1",
      secretId: process.env.AWS_SECRET_ID || "",
      versionId: process.env.AWS_SECRET_VERSION_ID,
    },
    vault: {
      endpoint: process.env.VAULT_ENDPOINT || "http://localhost:8200",
      token: process.env.VAULT_TOKEN || "",
      secretPath: process.env.VAULT_SECRET_PATH || "secret/data/heliobond",
    },
    azure: {
      vaultUrl: process.env.AZURE_VAULT_URL || "",
      tenantId: process.env.AZURE_TENANT_ID || "",
      clientId: process.env.AZURE_CLIENT_ID || "",
      clientSecret: process.env.AZURE_CLIENT_SECRET || "",
    },
    rotation: {
      enabled: process.env.SECRETS_ROTATION_ENABLED === "true",
      intervalMs: parseInt(process.env.SECRETS_ROTATION_INTERVAL_MS || "3600000", 10),
    },
  };
}

async function fetchFromEnv(key: string): Promise<string | undefined> {
  return process.env[key];
}

async function fetchFromAws(key: string): Promise<string | undefined> {
  try {
    const config = getConfig().aws;
    if (!config?.secretId) {
      logger.warn("[secrets] AWS Secrets Manager not configured");
      return undefined;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
      const client = new SecretsManagerClient({ region: config.region });
      const command = new GetSecretValueCommand({
        SecretId: config.secretId,
        VersionId: config.versionId,
      });
      const response = await client.send(command);
      if (response.SecretString) {
        const secrets = JSON.parse(response.SecretString);
        return secrets[key];
      }
      return undefined;
    } catch (importErr: any) {
      logger.warn("[secrets] AWS SDK not available, falling back to env", { error: importErr.message });
      return process.env[key];
    }
  } catch (err: any) {
    logger.error("[secrets] AWS Secrets Manager fetch failed", { error: err.message });
    return undefined;
  }
}

async function fetchFromVault(key: string): Promise<string | undefined> {
  try {
    const config = getConfig().vault;
    if (!config?.endpoint || !config?.token) {
      logger.warn("[secrets] HashiCorp Vault not configured");
      return undefined;
    }
    const response = await fetch(`${config.endpoint}/v1/${config.secretPath}`, {
      headers: {
        "X-Vault-Token": config.token,
      },
    });
    if (!response.ok) {
      logger.error("[secrets] Vault fetch failed", { status: response.status });
      return undefined;
    }
    const data: any = await response.json();
    return data.data?.data?.[key] || data.data?.[key];
  } catch (err: any) {
    logger.error("[secrets] Vault fetch failed", { error: err.message });
    return undefined;
  }
}

async function fetchFromAzure(key: string): Promise<string | undefined> {
  try {
    const config = getConfig().azure;
    if (!config?.vaultUrl || !config?.tenantId) {
      logger.warn("[secrets] Azure Key Vault not configured");
      return undefined;
    }
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: "https://vault.azure.net/.default",
        }),
      },
    );
    if (!tokenResponse.ok) {
      logger.error("[secrets] Azure token fetch failed", { status: tokenResponse.status });
      return undefined;
    }
    const tokenData: any = await tokenResponse.json();
    const secretResponse = await fetch(
      `${config.vaultUrl}/secrets/${key}?api-version=7.4`,
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
    );
    if (!secretResponse.ok) {
      logger.error("[secrets] Azure secret fetch failed", { status: secretResponse.status });
      return undefined;
    }
    const secretData: any = await secretResponse.json();
    return secretData.value;
  } catch (err: any) {
    logger.error("[secrets] Azure Key Vault fetch failed", { error: err.message });
    return undefined;
  }
}

export async function getSecret(key: string): Promise<string | undefined> {
  const cached = cache.secrets.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const config = getConfig();
  let value: string | undefined;

  switch (config.provider) {
    case "aws":
      value = await fetchFromAws(key);
      break;
    case "vault":
      value = await fetchFromVault(key);
      break;
    case "azure":
      value = await fetchFromAzure(key);
      break;
    case "env":
    default:
      value = await fetchFromEnv(key);
      break;
  }

  if (value !== undefined) {
    cache.secrets.set(key, value);
  }

  return value;
}

export async function getSecretWithFallback(
  secretKey: string,
  envKey: string,
): Promise<string | undefined> {
  const secretValue = await getSecret(secretKey);
  if (secretValue !== undefined) {
    return secretValue;
  }
  return process.env[envKey];
}

let rotationTimer: ReturnType<typeof setInterval> | null = null;

export async function rotateSecrets(): Promise<void> {
  logger.info("[secrets] rotating cached secrets");
  cache.secrets.clear();
  cache.lastRotated = Date.now();
}

export function startSecretRotation(): void {
  const config = getConfig();
  if (!config.rotation?.enabled) {
    return;
  }

  if (rotationTimer) {
    clearInterval(rotationTimer);
  }

  rotationTimer = setInterval(async () => {
    try {
      await rotateSecrets();
    } catch (err: any) {
      logger.error("[secrets] rotation failed", { error: err.message });
    }
  }, config.rotation.intervalMs);

  logger.info("[secrets] rotation started", { intervalMs: config.rotation.intervalMs });
}

export function stopSecretRotation(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
}

export function getSecretsStatus(): {
  provider: SecretsProvider;
  cachedKeys: string[];
  lastRotated: string;
  rotationEnabled: boolean;
} {
  const config = getConfig();
  return {
    provider: config.provider,
    cachedKeys: Array.from(cache.secrets.keys()),
    lastRotated: new Date(cache.lastRotated).toISOString(),
    rotationEnabled: config.rotation?.enabled ?? false,
  };
}
