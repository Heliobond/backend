/**
 * Typed environment variables.
 *
 * Declaration merging into `NodeJS.ProcessEnv` gives every `process.env.X`
 * access IDE autocomplete and catches typos at compile time (an unknown key
 * is an error rather than a silent `undefined`).
 *
 * Every variable is declared `string | undefined` — the process environment
 * is untyped strings and any variable may be absent at runtime, so callers
 * must still parse and default. Prefer reading values through `src/config.ts`
 * (`config`, `requireEnv`, `numEnv`, …) instead of touching `process.env`
 * directly; this declaration exists to make the remaining direct reads safe.
 *
 * When you add a new variable: declare it here and document it in
 * `.env.example`.
 */
declare namespace NodeJS {
  interface ProcessEnv {
    // ── Runtime ─────────────────────────────────────────────────────────
    /** "development" | "test" | "staging" | "production". Default: development */
    NODE_ENV?: string;
    /** Injected by npm/yarn at run time; used as the APM service version. */
    npm_package_version?: string;

    // ── Stellar / Soroban ───────────────────────────────────────────────
    /** "testnet" | "mainnet". Default: testnet */
    STELLAR_NETWORK?: string;
    /** Required. Stellar secret key (S…) signing update_impact_score txs. */
    ADMIN_SECRET_KEY?: string;
    /** Required. Soroban contract address of the ProjectRegistry. */
    PROJECT_REGISTRY_CONTRACT_ID?: string;
    /** Soroban RPC endpoint. Default: https://soroban-testnet.stellar.org */
    RPC_URL?: string;
    /** Multichain: Stellar RPC endpoint override. */
    STELLAR_RPC_URL?: string;
    /** Multichain: Ethereum RPC endpoint; empty disables the chain. */
    ETH_RPC_URL?: string;
    /** Multichain: Ethereum registry contract address. */
    ETH_CONTRACT_ADDRESS?: string;
    /** Multichain: Polygon RPC endpoint; empty disables the chain. */
    POLYGON_RPC_URL?: string;
    /** Multichain: Polygon registry contract address. */
    POLYGON_CONTRACT_ADDRESS?: string;

    // ── HTTP server ─────────────────────────────────────────────────────
    /** Integer port the API listens on. Default: 3001 */
    PORT?: string;
    /** Origin allowed by CORS. Default: http://localhost:3000 */
    FRONTEND_URL?: string;
    /** Comma-separated additional CORS origins. */
    CORS_ORIGINS?: string;
    /** Bearer token for /api/admin/*; unset skips admin auth (dev only). */
    ADMIN_API_KEY?: string;
    /** Token required to open a /ws connection; falls back to ADMIN_API_KEY. */
    WS_AUTH_TOKEN?: string;
    /** Integer byte threshold above which responses are compressed. Default: 1024 */
    COMPRESSION_THRESHOLD?: string;
    /** Integer gzip level 0–9. Default: 6 */
    COMPRESSION_LEVEL?: string;
    /** Integer ms to wait for in-flight work on shutdown. Default: 30000 */
    SHUTDOWN_TIMEOUT_MS?: string;
    /** Integer inclusive upper bound accepted for a `:id` project param. Default: 1000000 */
    MAX_PROJECT_ID?: string;

    // ── Database ────────────────────────────────────────────────────────
    DB_HOST?: string;
    /** Integer port. Default: 5432 */
    DB_PORT?: string;
    DB_NAME?: string;
    DB_USER?: string;
    DB_PASSWORD?: string;
    /** Integer minimum pooled connections. Default: 2 */
    DB_POOL_MIN?: string;
    /** Integer maximum pooled connections. Default: 10 */
    DB_POOL_MAX?: string;
    /** Integer ms to wait for a free connection. Default: 5000 */
    DB_POOL_ACQUIRE_TIMEOUT_MS?: string;
    /** Integer ms between pool health checks. Default: 30000 */
    DB_POOL_HEALTH_CHECK_INTERVAL_MS?: string;

    // ── Resilience ──────────────────────────────────────────────────────
    /** Integer consecutive RPC failures that open the breaker. Default: 5 */
    RPC_BREAKER_FAILURE_THRESHOLD?: string;
    /** Integer ms the breaker stays open before a probe. Default: 30000 */
    RPC_BREAKER_RECOVERY_TIMEOUT_MS?: string;
    /** Integer transaction retry attempts. Default: 4 */
    TX_MAX_RETRIES?: string;
    /** Integer ms base backoff between retries. Default: 200 */
    TX_RETRY_BASE_DELAY_MS?: string;
    /** Integer ms cap on retry backoff. Default: 10000 */
    TX_RETRY_MAX_DELAY_MS?: string;

    // ── Cron & IoT ──────────────────────────────────────────────────────
    /** IANA timezone for cron/hourly seed boundaries. Default: UTC */
    CRON_TIMEZONE?: string;
    /** Float 0–1 failure ratio that marks a cron run unhealthy. Default: 0.5 */
    CRON_FAILURE_THRESHOLD?: string;
    /** "true" disables the in-memory IoT reading cache. */
    IOT_CACHE_DISABLED?: string;
    /** Integer max entries retained by the IoT reading cache. Default: 1000 */
    IOT_CACHE_MAX_SIZE?: string;
    /** Integer ms satellite readings stay cached. Default: 7200000 */
    SATELLITE_CACHE_TTL_MS?: string;
    /** Integer consecutive source failures before alerting. Default: 3 */
    SATELLITE_ALERT_THRESHOLD?: string;

    // ── Rate limiting & access control ──────────────────────────────────
    /** Integer ms public rate-limit window. Default: 60000 */
    RATE_LIMIT_WINDOW_MS?: string;
    /** Integer max public requests per window per IP. Default: 100 */
    RATE_LIMIT_MAX?: string;
    /** Integer ms admin rate-limit window. Default: 60000 */
    RATE_LIMIT_ADMIN_WINDOW_MS?: string;
    /** Integer max admin requests per window per IP. Default: 20 */
    RATE_LIMIT_ADMIN_MAX?: string;
    /** Comma-separated IPs/CIDRs allowed on admin routes; empty disables. */
    ADMIN_IP_WHITELIST?: string;
    /** "false" stops private/internal ranges bypassing the whitelist. */
    ADMIN_IP_WHITELIST_BYPASS_PRIVATE?: string;
    /** HMAC secret for request signature verification; empty disables. */
    REQUEST_SIGNING_SECRET?: string;
    /** Secrets backend: "env" | provider name. Default: env */
    SECRETS_PROVIDER?: string;

    // ── Logging & APM ───────────────────────────────────────────────────
    /** "debug" | "info" | "warn" | "error". Default: derived from NODE_ENV */
    LOG_LEVEL?: string;
    /** "datadog" | "newrelic" | "opentelemetry" | "none". Default: none */
    APM_PROVIDER?: string;
    DD_SERVICE?: string;
    DD_ENV?: string;
    DD_VERSION?: string;
    DD_AGENT_HOST?: string;
    NEW_RELIC_LICENSE_KEY?: string;
    NEW_RELIC_APP_NAME?: string;
    OTEL_SERVICE_NAME?: string;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string;
    /** "false" disables the OTLP exporter. */
    OTEL_EXPORTER_OTLP_ENABLED?: string;
    OTEL_ZIPKIN_ENDPOINT?: string;
    /** "true" enables the Zipkin exporter. */
    OTEL_ZIPKIN_ENABLED?: string;
  }
}
