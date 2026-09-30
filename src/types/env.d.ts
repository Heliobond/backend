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
    /** Maximum age of signed admin requests in milliseconds. */
    ADMIN_REQUEST_MAX_AGE_MS?: string;
    /** Optional initial admin identity for RBAC bootstrap. */
    INITIAL_ADMIN_USER_ID?: string;
    /** Token required to open a /ws connection; falls back to ADMIN_API_KEY. */
    WS_AUTH_TOKEN?: string;
    /** "true" requires a signed wallet challenge on creator endpoints. Default: false */
    WALLET_AUTH_REQUIRE_SIGNATURE?: string;
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
    /** Consecutive failures before the circuit breaker opens. */
    CIRCUIT_BREAKER_THRESHOLD?: string;
    /** Cooldown in milliseconds before a circuit breaker probe. */
    CIRCUIT_BREAKER_COOLDOWN_MS?: string;
    /** Maximum Stellar RPC retry attempts. */
    RPC_MAX_RETRIES?: string;
    /** Base Stellar RPC retry delay in milliseconds. */
    RPC_RETRY_BASE_MS?: string;
    /** Poll interval in milliseconds for transaction status. */
    POLL_INTERVAL_MS?: string;
    /** Maximum transaction polling attempts. */
    POLL_MAX_ATTEMPTS?: string;
    /** Transaction timeout in seconds. */
    TX_TIMEOUT_SECONDS?: string;

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
    /** Maximum expected solar output in kW. */
    MAX_POWER_KW?: string;
    /** Idempotency record lifetime in milliseconds. */
    IDEMPOTENCY_TTL_MS?: string;

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
    /** Express trust-proxy setting. */
    TRUST_PROXY?: string;
    /** HMAC secret for request signature verification; empty disables. */
    REQUEST_SIGNING_SECRET?: string;
    /** Secrets backend. Default: env. */
    SECRETS_PROVIDER?: "env" | "aws" | "vault" | "azure";

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
    /** Maximum request body size accepted by Express. */
    BODY_SIZE_LIMIT?: string;
    /** Optional CA bundle path for database TLS. */
    DB_SSL_CA_PATH?: string;
    /** Optional database CA contents from deployment configuration. */
    DATABASE_CA?: string;

    // ── Soroban vault & indexer ─────────────────────────────────────────
    /** Soroban contract address of the InvestmentVault. */
    INVESTMENT_VAULT_CONTRACT_ID?: string;
    /** Integer ledger the vault event indexer starts from. Default: 0 */
    VAULT_EVENT_INDEXER_START_LEDGER?: string;
    /** "true" enables the vault event indexer. Default: false */
    VAULT_EVENT_INDEXER_ENABLED?: string;
    /** Positive integer max events retained by the indexer. Default: 1000 */
    VAULT_EVENT_INDEXER_MAX_EVENTS?: string;

    // ── gRPC, health & timeouts ─────────────────────────────────────────
    /** Integer port the gRPC server listens on. Default: 50051 */
    GRPC_PORT?: string;
    /** Integer ms RPC must be unreachable before an outage is reported. Default: 300000 */
    RPC_OUTAGE_THRESHOLD_MS?: string;
    /** Integer ms each dependency health check may take. Default: 1000 */
    HEALTH_CHECK_TIMEOUT_MS?: string;
    /** Integer ms before a request times out. Default: 30000 */
    REQUEST_TIMEOUT_MS?: string;
    /** Integer ms before an admin request times out. Default: 60000 */
    ADMIN_REQUEST_TIMEOUT_MS?: string;
    /** Integer ms window for error-log rate limiting. Default: 60000 */
    ERROR_RATE_LIMIT_WINDOW_MS?: string;

    // ── Batch jobs, webhooks & queues ───────────────────────────────────
    /** Integer ms a finished batch job is retained. Default: 3600000 */
    BATCH_JOB_TTL_MS?: string;
    /** Integer max batch jobs retained. Default: 1000 */
    BATCH_JOB_MAX_SIZE?: string;
    /** Integer ms between webhook store cleanups. Default: 3600000 */
    WEBHOOK_CLEANUP_INTERVAL_MS?: string;
    /** Integer ms after which a webhook entry is stale. Default: 86400000 */
    WEBHOOK_STALE_THRESHOLD_MS?: string;
    /** Integer retry attempts for queued transactions. Default: 10 */
    TX_QUEUE_MAX_RETRIES?: string;
    /** Integer max score history entries per project. */
    SCORE_HISTORY_MAX_ENTRIES_PER_PROJECT?: string;
    /** Integer ms score history entries are retained. */
    SCORE_HISTORY_TTL_MS?: string;
    /** Integer ms after which an IoT reading counts as stale. */
    STALE_READING_MAX_AGE_MS?: string;

    // ── Database (extra) ────────────────────────────────────────────────
    /** Integer ms to acquire a connection in knexfile. Default: 30000 */
    DB_ACQUIRE_TIMEOUT_MS?: string;
    /** Integer ms a pooled connection may sit idle in knexfile. Default: 60000 */
    DB_IDLE_TIMEOUT_MS?: string;
    /** Legacy alias for DB_SSL_CA_PATH. */
    DB_SSL_CA?: string;

    // ── Auth & secrets ──────────────────────────────────────────────────
    /** Comma-separated admin API keys, optionally with roles. */
    ADMIN_API_KEYS?: string;
    /** Base64 Ed25519 seed signing impact certificates. */
    IMPACT_CERTIFICATE_PRIVATE_KEY?: string;
    /** "true" enables periodic secrets rotation. */
    SECRETS_ROTATION_ENABLED?: string;
    /** Integer ms between secrets rotations. Default: 3600000 */
    SECRETS_ROTATION_INTERVAL_MS?: string;
    /** AWS region for Secrets Manager. Default: us-east-1 */
    AWS_REGION?: string;
    AWS_SECRET_ID?: string;
    AWS_SECRET_VERSION_ID?: string;
    /** Vault server URL. Default: http://localhost:8200 */
    VAULT_ENDPOINT?: string;
    VAULT_TOKEN?: string;
    /** Default: secret/data/heliobond */
    VAULT_SECRET_PATH?: string;
    AZURE_VAULT_URL?: string;
    AZURE_TENANT_ID?: string;
    AZURE_CLIENT_ID?: string;
    AZURE_CLIENT_SECRET?: string;

    // ── Email, URLs & audit ─────────────────────────────────────────────
    SENDGRID_API_KEY?: string;
    /** Sender address. Default: no-reply@heliobond.dev */
    EMAIL_FROM?: string;
    /** HMAC secret for unsubscribe links; random per process if unset. */
    EMAIL_UNSUBSCRIBE_SECRET?: string;
    /** Public API base URL used in emails; falls back to FRONTEND_URL. */
    PUBLIC_API_URL?: string;
    /** Public base URL used in notifications. Default: http://localhost:3001 */
    PUBLIC_BASE_URL?: string;
    /** Audit log path, or "stdout". Default: logs/audit.log (empty in test) */
    AUDIT_LOG_FILE?: string;
  }
}
