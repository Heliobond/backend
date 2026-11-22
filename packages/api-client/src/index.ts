/**
 * Heliobond API Client
 * Auto-generated from OpenAPI spec. Do not edit manually.
 * Run 'bun run api-client:generate' in the backend to regenerate.
 */

import type { paths } from "./types.js";
import createClient, { type Middleware, type Client } from "openapi-fetch";

/**
 * Configuration options for the API client
 */
export interface ApiClientConfig {
  /** Base URL of the API (e.g., 'https://api.heliobond.com/v1') */
  baseUrl: string;
  /** Optional middleware for request/response interception */
  middleware?: Middleware[];
  /** Default headers to include with every request */
  headers?: Record<string, string>;
}

/**
 * Create a typed API client for the Heliobond backend
 * @param config - Client configuration
 * @returns Typed fetch client with full TypeScript support
 */
export function createApiClient(config: ApiClientConfig): Client<paths> {
  const client = createClient<paths>({
    baseUrl: config.baseUrl,
    headers: config.headers,
  });

  if (config.middleware) {
    config.middleware.forEach((mw) => client.use(mw));
  }

  return client;
}

/**
 * Default export for convenience
 */
export default createApiClient;

/**
 * Re-export types for consumers
 */
export type { paths } from "./types.js";
