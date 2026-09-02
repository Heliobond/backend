# Role-Based Access Control (RBAC)

This document describes the role-based access control system for admin and IoT API endpoints.

## Overview

The API implements role-based access control using API key bearer tokens. Each API key can be assigned a specific role that determines what operations it can perform.

## Supported Roles

### Admin Roles

- **`admin:read`** — Read-only access to admin endpoints
  - Can retrieve audit logs
  - Cannot trigger score updates
  
- **`admin:write`** — Full admin access (includes all `admin:read` permissions)
  - Can trigger score updates
  - Can retrieve audit logs

### IoT Roles

- **`iot:read`** — Access to IoT endpoints
  - Can read solar and satellite data

## Environment Variables

API keys and their roles are configured via environment variables. The system supports two formats:

### Single Key with Role

Use `ADMIN_API_KEY` for backward compatibility:

```bash
# With explicit role
ADMIN_API_KEY=your_secret_key:admin:write

# Without explicit role (defaults to admin:write for backward compatibility)
ADMIN_API_KEY=your_secret_key
```

### Multiple Keys with Different Roles

Use `ADMIN_API_KEYS` to configure multiple API keys with different roles:

```bash
ADMIN_API_KEYS=key1:admin:read,key2:admin:write,key3:iot:read
```

Each entry should follow the format: `api_key:role`

## API Key Format

API keys can contain colons. The system parses the role from the rightmost colon:

```
key:admin:write   → key="key", role="admin:write"
my:secret:key:admin:read  → key="my:secret:key", role="admin:read"
```

## Authentication

All requests to admin endpoints must include a Bearer token:

```bash
curl -H "Authorization: Bearer your_api_key:admin:write" \
  https://api.example.com/api/admin/audit
```

For IoT endpoints, authentication is optional. If provided, the role will be validated if restrictions are enabled in the future.

## Endpoint Authorization

### Admin Endpoints

| Endpoint | Method | Required Role | Description |
|----------|--------|---------------|-------------|
| `/api/admin/audit` | GET | `admin:read` | Retrieve audit log of score updates |
| `/api/admin/update-scores` | POST | `admin:write` | Trigger score updates for projects |

### IoT Endpoints

| Endpoint | Method | Required Role | Description |
|----------|--------|---------------|-------------|
| `/api/iot/solar/:id` | GET | Optional | Get solar data simulation for a project |
| `/api/iot/satellite/:id` | GET | Optional | Get satellite data for a project |

## Permission Hierarchy

`admin:write` is a superset of `admin:read`. This means:

- A key with `admin:write` role can access endpoints requiring `admin:read`
- A key with `admin:read` role cannot access endpoints requiring `admin:write`
- Each role can only access endpoints within its category

## Error Responses

### Missing Authorization

When no Bearer token is provided to a protected endpoint:

```json
{
  "error": "unauthorized",
  "message": "Missing or invalid bearer token"
}
```

HTTP Status: `401 Unauthorized`

### Insufficient Permissions

When a Bearer token is provided but lacks the required role:

```json
{
  "error": "forbidden",
  "message": "This action requires the 'admin:write' role or higher"
}
```

HTTP Status: `403 Forbidden`

## Implementation Details

### Libraries

- `src/lib/apiKeyRoles.ts` — API key registry and role validation logic
- `src/middleware/requireApiKeyRole.ts` — Express middleware for role enforcement

### Configuration

API keys are loaded during application startup via `config.initEnv()`, which calls `loadApiKeysFromEnv()`.

## Best Practices

1. **Use Specific Roles** — Assign the least permissive role needed for each use case
   - Use `admin:read` for monitoring and audit log retrieval
   - Use `admin:write` only for automation that requires score updates

2. **Rotate Keys Regularly** — Periodically rotate API keys to reduce exposure

3. **Secure Storage** — Store API keys securely (e.g., in encrypted secret management systems)

4. **Monitor Usage** — Track which API keys are used and for what purposes

5. **Separate Keys by Purpose** — Use different keys for different services or clients

## Migration Guide

### From Single Key to Multiple Keys

If you're currently using a single `ADMIN_API_KEY`:

**Before:**
```bash
ADMIN_API_KEY=my_secret_key
```

**After (Option 1 - Keep backward compatibility):**
```bash
ADMIN_API_KEY=my_secret_key:admin:write
```

**After (Option 2 - Use new multiple-key format):**
```bash
ADMIN_API_KEYS=my_secret_key:admin:write,readonly_key:admin:read
```

The system will automatically use `ADMIN_API_KEYS` if set, otherwise fall back to `ADMIN_API_KEY`.

## Future Enhancements

- Audit trail for API key access
- Key expiration and automatic rotation
- Rate limiting per role
- OAuth2 / JWT support for user-based roles
