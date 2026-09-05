/**
 * Role-based API key management for admin and IoT endpoints.
 * Supports role syntax in API keys: "key:admin:write" or "key:admin:read"
 */

export type AdminRole = "admin:read" | "admin:write";
export type IoTRole = "iot:read";
export type ApiKeyRole = AdminRole | IoTRole;

interface ApiKeyEntry {
    key: string;
    role: ApiKeyRole;
}

// In-memory registry of API keys and their roles
const apiKeyRegistry = new Map<string, ApiKeyRole>();

/**
 * Parse a single API key entry with role.
 * Format: "key:role" (e.g., "secret123:admin:write")
 * The key can contain colons, so we split from the right (last part is the role).
 */
export function parseApiKeyEntry(entry: string): ApiKeyEntry | null {
    const trimmed = entry.trim();
    if (!trimmed) return null;

    // Split from the right to find the role (last segment after last colon)
    const lastColon = trimmed.lastIndexOf(":");
    if (lastColon === -1) {
        // No role specified, treat entire string as key with no role
        return null;
    }

    const key = trimmed.substring(0, lastColon);
    const role = trimmed.substring(lastColon + 1);

    if (!isValidRole(role)) {
        return null;
    }

    return { key, role: role as ApiKeyRole };
}

/**
 * Check if a string is a valid role.
 */
function isValidRole(role: string): role is ApiKeyRole {
    return (
        role === "admin:read" ||
        role === "admin:write" ||
        role === "iot:read"
    );
}

/**
 * Register an API key with its role.
 */
export function registerApiKey(key: string, role: ApiKeyRole): void {
    if (key.trim()) {
        apiKeyRegistry.set(key, role);
    }
}

/**
 * Get the role for a given API key, or undefined if not found.
 */
export function getApiKeyRole(key: string): ApiKeyRole | undefined {
    return apiKeyRegistry.get(key);
}

/**
 * Clear all registered API keys (useful for testing).
 */
export function clearApiKeys(): void {
    apiKeyRegistry.clear();
}

/**
 * Check if a role has permission for a required role.
 * - admin:write has permissions for both admin:read and admin:write
 * - admin:read has permissions only for admin:read
 * - iot:read has permissions only for iot:read
 */
export function hasRolePermission(userRole: ApiKeyRole | undefined, requiredRole: ApiKeyRole): boolean {
    if (!userRole) return false;

    // admin:write can do everything
    if (userRole === "admin:write") {
        return requiredRole === "admin:read" || requiredRole === "admin:write";
    }

    // Exact role match required for all other roles
    return userRole === requiredRole;
}

/**
 * Load API keys from environment variables.
 * Supports two formats:
 * 1. ADMIN_API_KEY=key:admin:write (single key with role)
 * 2. ADMIN_API_KEYS=key1:admin:read,key2:admin:write (multiple keys with roles)
 * 3. Legacy: ADMIN_API_KEY=secret (no role specified, defaults to admin:write for backward compat)
 */
export function loadApiKeysFromEnv(): void {
    clearApiKeys();

    // Try ADMIN_API_KEYS first (supports multiple keys)
    const multiKeyEnv = process.env.ADMIN_API_KEYS;
    if (multiKeyEnv) {
        const entries = multiKeyEnv.split(",");
        for (const entry of entries) {
            const parsed = parseApiKeyEntry(entry);
            if (parsed) {
                registerApiKey(parsed.key, parsed.role);
            }
        }
        return;
    }

    // Fall back to ADMIN_API_KEY
    const singleKeyEnv = process.env.ADMIN_API_KEY;
    if (singleKeyEnv) {
        const parsed = parseApiKeyEntry(singleKeyEnv);
        if (parsed) {
            // Key has explicit role
            registerApiKey(parsed.key, parsed.role);
        } else {
            // Legacy format: no role specified, default to admin:write for backward compatibility
            registerApiKey(singleKeyEnv, "admin:write");
        }
    }
}

/**
 * List all registered API keys and their roles (for debugging/admin purposes).
 * Only expose keys in a hashed or masked form in production.
 */
export function listApiKeys(): Array<{ key: string; role: ApiKeyRole }> {
    return Array.from(apiKeyRegistry.entries()).map(([key, role]) => ({ key, role }));
}
