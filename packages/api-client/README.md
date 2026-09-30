# @heliobond/api-client

Type-safe API client for the Heliobond backend, generated from the OpenAPI specification.

## Installation

```bash
npm install @heliobond/api-client openapi-fetch
```

## Usage

```typescript
import { createApiClient } from "@heliobond/api-client";

const api = createApiClient({
  baseUrl: "https://api.heliobond.com/v1",
  headers: {
    "X-User-Id": "user-123", // For admin endpoints
  },
});

// Fully typed API calls
const projects = await api.GET("/projects");
const project = await api.GET("/projects/{id}", { params: { path: { id: 1 } } });
const portfolio = await api.GET("/portfolio");
```

## Regenerating

This package is auto-generated from the backend's OpenAPI spec. To regenerate:

1. In the backend repo: `bun run openapi:export`
2. Then: `bun run api-client:generate`
3. Then: `bun run api-client:build`
4. Then: `bun run api-client:publish` (requires npm auth)

## Versioning

The client version follows the backend's OpenAPI spec version (info.version).
