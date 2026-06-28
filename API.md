# Heliobond Backend — API Reference

Base URL (local): `http://localhost:3001`

All responses are JSON. Errors use a consistent shape:

```json
{ "error": "bad_request", "message": "project id must be a positive integer" }
```

| Status | `error` code         | When |
|--------|----------------------|------|
| `400`  | `bad_request`        | Invalid params, body, or malformed JSON |
| `401`  | `unauthorized`       | Missing/invalid admin bearer token |
| `404`  | `not_found`          | Unknown route |
| `429`  | `too_many_requests`  | Rate limit exceeded (see `Retry-After`) |
| `500`  | `internal_error`     | Unexpected server error |

## Rate limiting

All `/api/*` endpoints are rate limited per client IP. Responses include the
standard `RateLimit-*` headers; a `429` additionally sets `Retry-After`.
Limits are configurable via environment variables (see
[`.env.example`](./.env.example)): `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`
(public) and `RATE_LIMIT_ADMIN_WINDOW_MS`, `RATE_LIMIT_ADMIN_MAX` (admin).

---

## `GET /health`

Liveness and basic operational visibility. Not rate limited.

**Response `200`**

```json
{
  "status": "ok",
  "uptime_seconds": 3712,
  "started_at": "2026-06-26T18:00:00.000Z",
  "last_cron_run": {
    "name": "score-update",
    "status": "success",
    "at": "2026-06-26T19:00:00.123Z"
  }
}
```

`last_cron_run` is `null` until the first scheduled job runs.

---

## `GET /api/iot/solar/:id`

Simulated solar-panel reading for project `id`. Readings are deterministic per
`(project_id, clock hour)`.

| Param | In   | Type | Rules |
|-------|------|------|-------|
| `id`  | path | int  | Positive integer (`>= 1`) |

**Response `200`**

```json
{
  "power_output_kw": 742.15,
  "efficiency_pct": 74.21,
  "max_power_kw": 1000,
  "timestamp": 1718150400000
}
```

**Errors:** `400` if `id` is not a positive integer.

---

## `GET /api/iot/satellite/:id`

Simulated satellite / vegetation reading for project `id`.

| Param | In   | Type | Rules |
|-------|------|------|-------|
| `id`  | path | int  | Positive integer (`>= 1`) |

**Response `200`**

```json
{
  "forest_density_pct": 68.44,
  "ndvi_score": 0.684,
  "timestamp": 1718150400000
}
```

**Errors:** `400` if `id` is not a positive integer.

---

## `GET /api/projects`

Paginated list of projects with their computed scores and latest readings.

| Param    | In    | Type | Rules | Default |
|----------|-------|------|-------|---------|
| `limit`  | query | int  | Non-negative integer; capped at `100` | `10` |
| `cursor` | query | int  | Non-negative integer (offset) | `0` |

**Response `200`**

```json
{
  "projects": [
    {
      "id": 1,
      "credit_quality": 74,
      "green_impact": 69,
      "power_output_kw": 742.15,
      "efficiency_pct": 74.21,
      "forest_density_pct": 68.44,
      "ndvi_score": 0.684,
      "timestamp": 1718150400000
    }
  ],
  "total": 1,
  "cursor": 10
}
```

`cursor` is present only when more results remain; pass it back as `?cursor=`.

**Errors:** `400` if `limit` or `cursor` is not a non-negative integer.

---

## `GET /api/projects/:id`

Detail for a single project.

| Param | In   | Type | Rules |
|-------|------|------|-------|
| `id`  | path | int  | Positive integer (`>= 1`) |

**Response `200`**

```json
{
  "id": 1,
  "credit_quality": 74,
  "green_impact": 69,
  "power_output_kw": 742.15,
  "efficiency_pct": 74.21,
  "forest_density_pct": 68.44,
  "ndvi_score": 0.684,
  "timestamp": 1718150400000,
  "funding": 482910.55
}
```

**Errors:** `400` if `id` is not a positive integer.

---

## `GET /api/portfolio/:address`

Indexed deposit/withdraw history and current position for an address.

| Param     | In   | Type   | Rules |
|-----------|------|--------|-------|
| `address` | path | string | Non-empty string |

**Response `200`**

```json
{
  "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "current_shares": 42,
  "current_value": 71.25,
  "events": [
    {
      "id": "1234-abcdef",
      "type": "deposit",
      "amount": 500,
      "shares": 42,
      "timestamp": 1718150400000,
      "txHash": "abcdef..."
    }
  ]
}
```

**Errors:** `400` if `address` is empty/missing.

---

## `POST /api/admin/update-scores`

Compute and submit `update_impact_score` transactions to the Soroban contract.
Stricter rate limit than public endpoints.

**Headers**

| Header          | Required | Value |
|-----------------|----------|-------|
| `Authorization` | When `ADMIN_API_KEY` is set | `Bearer <ADMIN_API_KEY>` |

**Body (optional)**

```json
{ "project_ids": [1, 2, 3] }
```

| Field         | Type     | Rules |
|---------------|----------|-------|
| `project_ids` | int[]    | Optional. Array of positive integers. Omit or send `[]` to update **every** registered project. |

**Response `200`**

```json
{
  "updated": 2,
  "results": [
    { "project_id": 1, "tx_hash": "abc123...", "credit_quality": 74, "green_impact": 69 }
  ],
  "errors": []
}
```

Per-project failures are collected in `errors` (the request still returns `200`);
Soroban does not support multi-call batching, so transactions are submitted
sequentially.

**Errors:**
- `400` if `project_ids` is present but not an array of positive integers, or the JSON body is malformed.
- `401` if `ADMIN_API_KEY` is set and the bearer token is missing/incorrect.

---

## Investor Reporting Endpoints

Endpoints designed for project investors to get dashboard data, performance reports, financial summaries, compliance status, and customized reporting.

### `GET /v1/investor/dashboard`
Returns portfolio-wide aggregated dashboard data and recent audit logs.

**Response `200`**
```json
{
  "portfolio_summary": {
    "total_projects": 2,
    "total_power_output_kw": 1150,
    "avg_credit_quality": 85,
    "avg_green_impact": 75,
    "total_portfolio_value": 950000,
    "total_carbon_offsets_tonnes": 4312.5
  },
  "recent_activities": [
    {
      "id": 1,
      "project_id": 1,
      "credit_quality": 85,
      "green_impact": 75,
      "tx_hash": "tx123",
      "triggered_by": "test",
      "timestamp": 1718150400000
    }
  ]
}
```

### `GET /v1/investor/performance-report`
Provides actual vs expected performance ratios and performance status for each project.

**Response `200`**
```json
{
  "generated_at": 1718150400000,
  "projects": [
    {
      "project_id": 1,
      "efficiency_pct": 82,
      "power_output_kw": 550,
      "ndvi_score": 0.75,
      "actual_vs_expected_ratio": 0.55,
      "performance_status": "Critical"
    }
  ]
}
```

### `GET /v1/investor/financial-summary`
Aggregates financial metrics like NPV, ROI, and payback period across the portfolio.

**Response `200`**
```json
{
  "portfolio_financials": {
    "total_installation_cost": 450000,
    "total_npv": 120000,
    "avg_payback_period_years": 6.8,
    "avg_roi_pct": 14.5
  },
  "projects": [
    {
      "project_id": 1,
      "installation_cost": 150000,
      "npv": 45000,
      "payback_period_years": 6.2,
      "roi_pct": 15.2
    }
  ]
}
```

### `GET /v1/investor/compliance-report`
Provides ESG compliance, verified carbon credits, and audit trails.

**Response `200`**
```json
{
  "portfolio_compliance": {
    "portfolio_esg_score": 75,
    "total_carbon_credits_issued": 20625,
    "portfolio_status": "Compliant"
  },
  "projects": [
    {
      "project_id": 1,
      "green_impact": 75,
      "ndvi_score": 0.75,
      "carbon_credits_issued": 20625,
      "compliance_status": "Compliant"
    }
  ],
  "audit_logs": []
}
```

### `POST /v1/investor/custom-report`
Generates a custom report based on specific project IDs and sections.

**Request Body**
```json
{
  "project_ids": [1],
  "sections": ["performance", "scores"]
}
```

**Response `200`**
```json
{
  "generated_at": 1718150400000,
  "project_count": 1,
  "projects": [
    {
      "project_id": 1,
      "scores": {
        "credit_quality": 85,
        "green_impact": 75
      },
      "performance": {
        "efficiency_pct": 82,
        "power_output_kw": 550,
        "actual_vs_expected_ratio": 0.55,
        "performance_status": "Critical"
      }
    }
  ]
}
```

---

## Consumer API Key Management

Admin endpoints (protected by `ADMIN_API_KEY`) to manage credentials for external consumers. 

External consumers can authenticate to `/v1/*` endpoints using `Authorization: Bearer <key>` or `X-API-Key: <key>`.

### `POST /v1/admin/api-keys`
Generates a new consumer API key.

**Request Body**
```json
{
  "consumer_name": "Third Party Service",
  "rate_limit": 100
}
```

**Response `201`**
```json
{
  "id": "e22709bf-6d60-449e-b9ef-2ea39544be6c",
  "key": "hk_live_4a56ff0bc...",
  "consumer_name": "Third Party Service",
  "status": "active",
  "rate_limit": 100,
  "usage_count": 0,
  "last_used_at": null,
  "created_at": 1718150400000
}
```

### `GET /v1/admin/api-keys`
Lists all generated consumer API keys.

**Response `200`**
```json
{
  "count": 1,
  "keys": [...]
}
```

### `POST /v1/admin/api-keys/:id/rotate`
Rotates a consumer's secret API key.

**Response `200`**
```json
{
  "id": "e22709bf-6d60-449e-b9ef-2ea39544be6c",
  "key": "hk_live_new_rotated_key_value...",
  ...
}
```

### `DELETE /v1/admin/api-keys/:id`
Revokes an API key, preventing future access.

**Response `200`**
```json
{
  "success": true,
  "message": "API key revoked successfully"
}
```

### `GET /v1/admin/api-keys/:id/usage`
Retrieves usage metrics and rate limits.

**Response `200`**
```json
{
  "id": "e22709bf-6d60-449e-b9ef-2ea39544be6c",
  "consumer_name": "Third Party Service",
  "usage_count": 42,
  "last_used_at": 1718150410000,
  "rate_limit": 100
}
```

---

## GraphQL API

Flexible querying interface served alongside the REST API. Authenticated with either admin or consumer key.

- **HTTP Endpoint**: `/graphql` (POST requests)
- **GraphiQL Playground**: `/graphql-playground` (GET request via browser)

### Example Query
```graphql
query {
  projects(limit: 5) {
    id
    credit_quality
    green_impact
    solar {
      power_output_kw
      efficiency_pct
    }
    financials {
      npv
      roi_pct
    }
  }
}
```

### Example Mutation (Requires `ADMIN_API_KEY`)
```graphql
mutation {
  updateProjectScores(id: "1", creditQuality: 90, greenImpact: 85) {
    id
    credit_quality
    green_impact
  }
}
```

---

## gRPC Service

High-performance gRPC interface listening on port `50051`. Authenticates callers via metadata (headers: `authorization` or `x-api-key`).

### Service Definition
```protobuf
service HeliobondService {
  rpc GetProjectScore(ProjectRequest) returns (ProjectResponse);
  rpc StreamProjectScores(StreamRequest) returns (stream ProjectResponse);
  rpc ChatProjectScores(stream ProjectRequest) returns (stream ProjectResponse);
}
```

- **`GetProjectScore`**: Unary call to retrieve a project's latest stats and scores.
- **`StreamProjectScores`**: Server-side streaming of project updates as they occur.
- **`ChatProjectScores`**: Bidirectional stream enabling clients to send project IDs and receive live updates back.

